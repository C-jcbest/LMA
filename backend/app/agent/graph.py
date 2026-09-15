"""LMA 主 Agent：官方 create_agent 接管 ReAct 循环与工具执行。

由 Agent Server 调用图工厂并注入 Thread/Checkpoint 持久化。
LMA middleware 维护业务时间、Prompt、展示元数据及推荐契约。
官方 SummarizationMiddleware 管理历史；推荐退出主 Run 在 TODO 23 实施。
"""

import json
import logging
from dataclasses import replace
from functools import lru_cache
from time import perf_counter

from langchain.agents import AgentState as BaseAgentState, create_agent
from langchain.agents.middleware import AgentMiddleware, ModelRetryMiddleware, ToolRetryMiddleware
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_openai import ChatOpenAI
from langgraph.errors import GraphBubbleUp

from app.beidou.client import BeidouApiError
from app.agent.tool_protocol import ToolFailure, VALIDATION_MESSAGE
from app.agent.context import build_context_budget
from app.agent.summarization import create_summarization_middleware, _get_summary_model
from app.agent.prompting import build_system_prompt, build_time_context
from app.agent.retry import is_transient_error
from app.agent.reasoning import ReasoningChatOpenAI, thinking_options
from app.agent.site import inspect_site_environment
from app.business_time import business_now
from app.agent.tools import get_daily_gnss_data, list_station_groups, list_stations
from app.agent.vision import analyze_gnss_chart
from app.agent.weather import query_weather
from app.config import get_settings

tools = [list_station_groups, list_stations, get_daily_gnss_data,
         query_weather, analyze_gnss_chart, inspect_site_environment]
logger = logging.getLogger(__name__)


class AgentState(BaseAgentState):
    business_time: str
    recommendations: list[str]
    recommendations_error: str
    context_usage: dict


@lru_cache
def _get_llm():
    settings = get_settings()
    return ReasoningChatOpenAI(
        model=settings.llm_model, api_key=settings.llm_api_key,
        base_url=settings.llm_base_url, temperature=0, max_retries=0,
        **thinking_options(settings.llm_thinking),
    )


class LmaMiddleware(AgentMiddleware):
    state_schema = AgentState

    def __init__(self, bound_tools):
        self.bound_tools = bound_tools

    async def abefore_agent(self, state, runtime):
        anchor = business_now().isoformat(timespec="seconds")
        messages = []
        if state["messages"] and state["messages"][-1].type == "human":
            message = state["messages"][-1]
            messages.append(message.model_copy(update={"additional_kwargs": {
                **message.additional_kwargs, "created_at": anchor,
            }}))
        return {**({"messages": messages} if messages else {}),
                "business_time": anchor, "recommendations": [], "recommendations_error": ""}

    async def awrap_model_call(self, request, handler):
        prompt = build_system_prompt(request.state["business_time"])
        started = perf_counter()
        response = await handler(request.override(
            system_message=SystemMessage(content=prompt),
        ))
        elapsed_ms = max(0, round((perf_counter() - started) * 1000))
        stamped = []
        for message in response.result:
            if message.type == "ai":
                metadata = {**message.additional_kwargs,
                            "created_at": business_now().isoformat(timespec="seconds")}
                reasoning = (metadata.get("reasoning_content") or metadata.get("reasoning")
                             or metadata.get("thinking")
                             or message.response_metadata.get("reasoning_content"))
                if isinstance(reasoning, str) and reasoning.strip():
                    metadata.update(reasoning_content=reasoning, lma_thinking_duration_ms=elapsed_ms)
                elif any(block.get("type") == "reasoning" for block in message.content_blocks):
                    metadata["lma_thinking_duration_ms"] = elapsed_ms
                message = message.model_copy(update={"additional_kwargs": metadata})
            stamped.append(message)
        return replace(response, result=stamped)

    async def aafter_model(self, state, runtime):
        message = state["messages"][-1]
        usage = getattr(message, "usage_metadata", None) or {}
        input_tokens = usage.get("input_tokens")
        if isinstance(input_tokens, int) and not isinstance(input_tokens, bool) and input_tokens >= 0:
            budget = build_context_budget(
                state["messages"][:-1],
                system_prompt=build_system_prompt(state["business_time"]), bound_tools=self.bound_tools,
            )
            return {"context_usage": budget.usage_snapshot(usage)}
        logger.warning("model response did not include input token usage; preserve previous context_usage")
        return None

    async def aafter_agent(self, state, runtime):
        return await generate_recommendations(state)

    async def awrap_tool_call(self, request, handler):
        try:
            result = await handler(request)
            if isinstance(result, ToolMessage) and result.status == "error" and not result.artifact:
                # 官方 schema 错误不含展示 artifact；只投影受控提示，不传输入或堆栈。
                message = VALIDATION_MESSAGE if result.content == VALIDATION_MESSAGE else "工具调用未完成，未取得可用数据。"
                return result.model_copy(update={"content": message, "artifact": {"data": {"message": message}, "error": {"category": "parameter" if result.content == VALIDATION_MESSAGE else "internal"}}})
            return result
        except ToolFailure as exc:
            return ToolMessage(content=exc.content, artifact=exc.artifact,
                tool_call_id=request.tool_call["id"], name=request.tool_call["name"], status="error")
        except GraphBubbleUp:
            raise
        except BeidouApiError:
            logger.warning("monitoring platform rejected tool request", exc_info=True)
            message = "监测平台拒绝本次查询，未取得可用数据，请检查账号访问权限或查询条件。"
            return ToolMessage(content=message, artifact={"data": {"message": message}, "error": {"category": "business"}},
                tool_call_id=request.tool_call["id"], name=request.tool_call["name"], status="error")
        except Exception as exc:
            logger.warning("tool execution failed without retry", exc_info=True)
            message = ("数据服务暂不可用，本次查询未取得可用数据，请稍后重试。"
                       if is_transient_error(exc) else "工具执行失败，未取得可用数据，请说明这一限制。")
            return ToolMessage(
                content=message, artifact={"data": {"message": message}, "error": {"category": "infrastructure" if is_transient_error(exc) else "internal"}},
                tool_call_id=request.tool_call["id"], name=request.tool_call["name"], status="error",
            )



RECOMMEND_PROMPT = """你是滑坡监测智能助手的“下一步建议”生成器。根据最近一轮对话（用户问题与助手回答），给出用户接下来最可能继续提出的 2~3 个后续问题。

要求：
- 每条是一个可直接发送的完整中文问题，不超过 30 字；
- 与已查询的监测点、时间范围、异常线索自然衔接（如跟进异常时段降雨、调整时间范围、对比其他监测点等）；
- 建议必须保持证据边界，不预设降雨导致形变或已发生滑坡，不建议给出风险百分比、失稳时间、官方预警等级或撤离命令；
- 只输出问题本身，不要编号、不要回答、不要解释；
- 对话与监测业务无关时返回空数组 []。

只输出一个 JSON 数组，例如：["查询该站点异常时段的降雨情况", "查看 9 月至今的累计位移趋势"]"""


@lru_cache
def _get_recommend_llm():
    """推荐动作生成用轻量 LLM：主模型 + 小输出预算。"""
    settings = get_settings()
    return ChatOpenAI(
        model=settings.llm_model,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        temperature=0.3,
        max_tokens=200,
        **thinking_options(settings.recommend_thinking),
    )


def _parse_recommendations(text: str) -> list[str]:
    """严格校验模型约定的 JSON 数组，不尝试修补或猜测结果。"""
    data = json.loads(text)
    if not isinstance(data, list) or not all(isinstance(item, str) for item in data):
        raise ValueError("recommendations must be a JSON string array")
    recommendations = [item.strip() for item in data if item.strip()]
    if recommendations and not 2 <= len(recommendations) <= 3:
        raise ValueError("recommendations must contain 2 or 3 items")
    if any(len(item) > 60 for item in recommendations):
        raise ValueError("recommendation exceeds 60 characters")
    return recommendations


def _message_text(message: BaseMessage) -> str:
    """按 LangChain 标准消息内容形式提取文本块。"""
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "".join(parts)


async def _generate_recommendations(
    user_text: str,
    answer_text: str,
    business_time: str | None,
) -> dict:
    """根据完整的最终回答生成下一步建议。"""
    if not answer_text.strip():
        return {
            "recommendations": [],
            "recommendations_error": "未找到可用的助手回答，无法生成下一步建议。",
        }
    try:
        response = await _get_recommend_llm().ainvoke(
            [
                SystemMessage(
                    content=RECOMMEND_PROMPT + "\n\n" + build_time_context(business_time)
                ),
                HumanMessage(
                    content=(
                        f"用户问题：{user_text}\n\n"
                        f"助手回答：{answer_text}"
                    )
                ),
            ],
            # 阻断辅助调用 token 被主消息流捕获，避免混入最终回答。
            config={"callbacks": []},
        )
        recommendations = _parse_recommendations(_message_text(response))
        return {"recommendations": recommendations, "recommendations_error": ""}
    except Exception:
        logger.warning("recommendation generation or validation failed", exc_info=True)
        return {"recommendations": [], "recommendations_error": "下一步建议生成失败。"}


async def generate_recommendations(state: AgentState) -> dict:
    """最终回答完成后按开关生成下一步建议。"""
    if not get_settings().recommend_enabled:
        return {
            "recommendations": [],
            "recommendations_error": "",
        }
    user_text = ""
    answer_text = ""
    for msg in reversed(state["messages"]):
        text = _message_text(msg)
        if not text.strip():
            continue
        if msg.type == "ai" and not answer_text:
            answer_text = text
        elif msg.type == "human" and not user_text:
            user_text = text
        if user_text and answer_text:
            break
    return await _generate_recommendations(
        user_text, answer_text, state.get("business_time")
    )


def create_lma_agent(model, *, agent_tools=None, checkpointer=None, retry_delay=0.5, summary_model=None):
    """生产与回归测试共用同一个官方 Agent 工厂。"""
    bound_tools = tools if agent_tools is None else agent_tools
    for agent_tool in bound_tools:
        agent_tool.handle_validation_error = VALIDATION_MESSAGE
    return create_agent(
        model, tools=bound_tools,
        state_schema=AgentState, checkpointer=checkpointer,
        middleware=[
            LmaMiddleware(bound_tools),
            create_summarization_middleware(
                _get_summary_model() if summary_model is None else summary_model,
            ),
            ModelRetryMiddleware(max_retries=2, retry_on=is_transient_error,
                                 on_failure="error", initial_delay=retry_delay),
            ToolRetryMiddleware(max_retries=2, retry_on=is_transient_error,
                                on_failure="error", initial_delay=retry_delay),
        ],
    )


def graph(config: RunnableConfig):
    """Agent Server 官方图工厂：模型延迟构建，不额外安装 checkpointer。"""
    return create_lma_agent(_get_llm())
