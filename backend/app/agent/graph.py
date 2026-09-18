"""LMA 主 Agent：官方 create_agent 接管 ReAct 循环与工具执行。

由 Agent Server 调用图工厂并注入 Thread/Checkpoint 持久化。
LMA middleware 维护展示元数据及推荐契约。
官方 SummarizationMiddleware 管理历史；推荐退出主 Run 在 TODO 23 实施。
"""

import asyncio
import json
import logging
import os
from dataclasses import replace
from functools import lru_cache

from langchain.agents import AgentState as BaseAgentState, create_agent
from langchain.agents.middleware import (
    AgentMiddleware,
    ModelRetryMiddleware,
    ToolRetryMiddleware,
    ToolErrorMiddleware,
    ModelCallLimitMiddleware,
    ToolCallLimitMiddleware,
)
from langchain_core.messages import BaseMessage, HumanMessage, RemoveMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langgraph.errors import GraphBubbleUp
from langgraph_sdk import get_client

from pydantic import BaseModel, Field
from app.beidou.client import BeidouApiError
from app.agent.tool_protocol import ToolFailure, VALIDATION_MESSAGE
from app.agent.context import build_context_budget
from app.agent.summarization import create_summarization_middleware, _get_summary_model
from app.agent.prompting import SYSTEM_PROMPT
from app.agent.retry import is_transient_error
from app.agent.models import create_chat_model
from app.agent.site import inspect_site_environment
from app.agent.title import _get_title_llm, clean_generated_title, SYSTEM_PROMPT as TITLE_SYSTEM_PROMPT
from app.business_time import business_now
from app.agent.tools import (
    get_current_time,
    get_daily_gnss_data,
    list_station_groups,
    list_stations,
)
from app.agent.vision import analyze_gnss_chart
from app.agent.weather import query_weather
from app.config import get_settings

tools = [get_current_time, list_station_groups, list_stations, get_daily_gnss_data,
         query_weather, analyze_gnss_chart, inspect_site_environment]
logger = logging.getLogger(__name__)


def _message_text(message: BaseMessage) -> str:
    """按 LangChain 官方 BaseMessage.text 属性提取纯文本。"""
    text = getattr(message, "text", None)
    if isinstance(text, str):
        return text
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    return ""


async def _maybe_auto_title(state: "AgentState", runtime) -> None:
    """首轮对话在后端提炼标题并持久化到 thread.metadata.name，异常静默不影响主回答。"""
    try:
        raw_messages = state.get("messages", [])
        human_messages = [m for m in raw_messages if m.type == "human"]
        if len(human_messages) != 1:
            return

        thread_id = None
        if hasattr(runtime, "execution_info") and runtime.execution_info:
            thread_id = getattr(runtime.execution_info, "thread_id", None)
        if not thread_id:
            from langchain_core.runnables import ensure_config
            thread_id = ensure_config().get("configurable", {}).get("thread_id")
        if not thread_id:
            return

        first_user_text = _message_text(human_messages[0]).strip()
        if not first_user_text:
            return

        api_url = os.environ.get("LANGGRAPH_API_URL") or "http://127.0.0.1:2024"
        client = get_client(url=api_url)

        try:
            thread_info = await client.threads.get(thread_id)
            current_name = (thread_info.get("metadata") or {}).get("name")
            if current_name and current_name != "新会话":
                return
        except Exception:
            pass

        title_llm = _get_title_llm()
        response = await title_llm.ainvoke(
            [
                SystemMessage(content=TITLE_SYSTEM_PROMPT),
                HumanMessage(content=first_user_text),
            ],
            config={"callbacks": []},
        )
        title = clean_generated_title(response.text)
        if title:
            await client.threads.update(thread_id, metadata={"name": title})
            logger.info("Auto-generated session title for thread %s: %s", thread_id, title)
    except Exception as exc:
        logger.warning("Auto-title generation encountered error: %s", exc)


def _sanitize_unanswered_tool_calls(messages: list[BaseMessage]) -> list[BaseMessage]:
    """服务端自愈：清除或收窄历史 checkpoint 中因客户端主动中断等遗留的未配对 AI tool-call。"""
    updates: list[BaseMessage] = []
    for idx, msg in enumerate(messages):
        if msg.type != "ai" or not getattr(msg, "tool_calls", None):
            continue
        # 统计紧随其后的连续 ToolMessage id
        answered_ids = set()
        for next_msg in messages[idx + 1:]:
            if next_msg.type == "tool":
                answered_ids.add(getattr(next_msg, "tool_call_id", None))
            elif next_msg.type in ("human", "ai"):
                break
        calls = msg.tool_calls
        if all(c.get("id") in answered_ids for c in calls):
            continue
        completed_calls = [c for c in calls if c.get("id") in answered_ids]
        if completed_calls:
            updates.append(msg.model_copy(update={"tool_calls": completed_calls}))
        elif msg.content and (not isinstance(msg.content, str) or msg.content.strip()):
            updates.append(msg.model_copy(update={"tool_calls": []}))
        elif getattr(msg, "id", None):
            updates.append(RemoveMessage(id=msg.id))
    return updates


def _on_tool_error(exc: Exception, request) -> str | None:
    """官方 ToolErrorMiddleware 回调：捕获通用工具异常并返回受控安全文案。"""
    if isinstance(exc, (ToolFailure, BeidouApiError)):
        return None
    logger.warning("tool execution failed: %s", exc, exc_info=True)
    if is_transient_error(exc):
        return "数据服务暂不可用，本次查询未取得可用数据，请稍后重试。"
    return "工具执行失败，未取得可用数据，请说明这一限制。"


class AgentState(BaseAgentState):
    recommendations: list[str]
    recommendations_error: str
    context_usage: dict


@lru_cache
def _get_llm():
    settings = get_settings()
    protocol = "responses" if settings.llm_provider == "openai" else "chat_completions"
    return create_chat_model(
        provider=settings.llm_provider,
        model=settings.llm_model,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        thinking=settings.llm_thinking,
        protocol=protocol,
        tool_loop=True,
        temperature=0,
    )



class LmaMiddleware(AgentMiddleware):
    state_schema = AgentState

    def __init__(self, bound_tools):
        self.bound_tools = bound_tools

    async def abefore_agent(self, state, runtime):
        anchor = business_now().isoformat(timespec="seconds")
        raw_messages = state.get("messages", [])
        updates = _sanitize_unanswered_tool_calls(raw_messages)
        if raw_messages and raw_messages[-1].type == "human":
            last_human = raw_messages[-1]
            updates.append(last_human.model_copy(update={"additional_kwargs": {
                **last_human.additional_kwargs, "created_at": anchor,
            }}))
        return {
            **({"messages": updates} if updates else {}),
            "recommendations": [],
            "recommendations_error": "",
        }

    async def awrap_model_call(self, request, handler):
        response = await handler(request)
        stamped = []
        for message in response.result:
            if message.type == "ai":
                metadata = {
                    **message.additional_kwargs,
                    "created_at": business_now().isoformat(timespec="seconds"),
                }
                message = message.model_copy(update={"additional_kwargs": metadata})
            stamped.append(message)
        return replace(response, result=stamped)

    async def aafter_model(self, state, runtime):
        index = next(i for i in range(len(state["messages"]) - 1, -1, -1) if state["messages"][i].type == "ai")
        message = state["messages"][index]
        usage = getattr(message, "usage_metadata", None) or {}
        input_tokens = usage.get("input_tokens")
        if isinstance(input_tokens, int) and not isinstance(input_tokens, bool) and input_tokens >= 0:
            budget = build_context_budget(
                state["messages"][:index],
                system_prompt=SYSTEM_PROMPT, bound_tools=self.bound_tools,
            )
            return {"context_usage": budget.usage_snapshot(usage)}
        logger.warning("model response did not include input token usage; preserve previous context_usage")
        return None

    async def aafter_agent(self, state, runtime):
        try:
            await asyncio.wait_for(_maybe_auto_title(state, runtime), timeout=3.5)
        except Exception as exc:
            logger.warning("auto-title attempt encountered exception: %s", exc)
        return await generate_recommendations(state)

    async def awrap_tool_call(self, request, handler):
        try:
            result = await handler(request)
            if isinstance(result, ToolMessage) and result.status == "error" and not result.artifact:
                # 官方 schema 校验错误与 ToolErrorMiddleware 产出的错误不含前端 artifact；为其统一补齐安全 envelope。
                is_param = (result.content == VALIDATION_MESSAGE)
                is_infra = ("暂不可用" in result.content)
                category = "parameter" if is_param else ("infrastructure" if is_infra else "internal")
                return result.model_copy(
                    update={
                        "artifact": {
                            "data": {"message": result.content},
                            "error": {"category": category},
                        }
                    }
                )
            return result
        except ToolFailure as exc:
            return ToolMessage(
                content=exc.content,
                artifact=exc.artifact,
                tool_call_id=request.tool_call["id"],
                name=request.tool_call["name"],
                status="error",
            )
        except GraphBubbleUp:
            raise
        except BeidouApiError:
            logger.warning("monitoring platform rejected tool request", exc_info=True)
            message = "监测平台拒绝本次查询，未取得可用数据，请检查账号访问权限或查询条件。"
            return ToolMessage(
                content=message,
                artifact={"data": {"message": message}, "error": {"category": "business"}},
                tool_call_id=request.tool_call["id"],
                name=request.tool_call["name"],
                status="error",
            )



RECOMMEND_PROMPT = """你是滑坡监测智能助手的“下一步建议”生成器。根据最近一轮对话（用户问题与助手回答），给出用户接下来最可能继续提出的 2~3 个后续问题。

要求：
- 每条是一个可直接发送的完整中文问题，不超过 30 字；
- 与已查询的监测点、时间范围、异常线索自然衔接（如跟进异常时段降雨、调整时间范围、对比其他监测点等）；
- 建议必须保持证据边界，不预设降雨导致形变或已发生滑坡，不建议给出风险百分比、失稳时间、官方预警等级或撤离命令；
- 只输出问题本身，不要编号、不要回答、不要解释；
- 对话与监测业务无关时返回空数组 []。

只输出一个 JSON 数组，例如：["查询该站点异常时段的降雨情况", "查看 9 月至今的累计位移趋势"]"""


class RecommendationResult(BaseModel):
    recommendations: list[str] = Field(
        default_factory=list,
        description="下一步建议问题列表，2到3条；对话与监测业务无关时返回空列表",
    )


@lru_cache
def _get_recommend_llm():
    """推荐动作生成用轻量 LLM：主模型 + 小输出预算。"""
    settings = get_settings()
    return create_chat_model(
        provider=settings.llm_provider,
        model=settings.llm_model,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        thinking=settings.recommend_thinking,
        protocol="chat_completions",
        temperature=0.3,
        max_tokens=200,
    )


def _validate_recommendations(items: list[str]) -> list[str]:
    """严格业务级校验：非空时2-3条，每条不超过60字。"""
    recommendations = [item.strip() for item in items if isinstance(item, str) and item.strip()]
    if recommendations and not 2 <= len(recommendations) <= 3:
        raise ValueError("recommendations must contain 2 or 3 items")
    if any(len(item) > 60 for item in recommendations):
        raise ValueError("recommendation exceeds 60 characters")
    return recommendations


async def _generate_recommendations(
    user_text: str,
    answer_text: str,
) -> dict:
    """根据完整的最终回答生成下一步建议。"""
    if not answer_text.strip():
        return {
            "recommendations": [],
            "recommendations_error": "未找到可用的助手回答，无法生成下一步建议。",
        }
    try:
        structured_llm = _get_recommend_llm().with_structured_output(
            RecommendationResult, method="json_schema", strict=True
        )
        result = await structured_llm.ainvoke(
            [
                SystemMessage(content=RECOMMEND_PROMPT),
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
        raw_items = result.recommendations if isinstance(result, RecommendationResult) else []
        recommendations = _validate_recommendations(raw_items)
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
    return await _generate_recommendations(user_text, answer_text)


def create_lma_agent(model, *, agent_tools=None, checkpointer=None, retry_delay=None, summary_model=None):
    """生产与回归测试共用同一个官方 Agent 工厂。"""
    settings = get_settings()
    bound_tools = tools if agent_tools is None else agent_tools
    for agent_tool in bound_tools:
        agent_tool.handle_validation_error = VALIDATION_MESSAGE
    return create_agent(
        model, tools=bound_tools,
        system_prompt=SYSTEM_PROMPT,
        state_schema=AgentState, checkpointer=checkpointer,
        middleware=[
            LmaMiddleware(bound_tools),
            create_summarization_middleware(
                _get_summary_model() if summary_model is None else summary_model,
            ),
            ModelCallLimitMiddleware(run_limit=settings.agent_model_run_limit, exit_behavior="error"),
            ToolCallLimitMiddleware(run_limit=settings.agent_tool_run_limit, exit_behavior="continue"),
            ModelRetryMiddleware(max_retries=settings.agent_max_retries, retry_on=is_transient_error,
                on_failure="error", initial_delay=settings.agent_retry_initial_delay if retry_delay is None else retry_delay,
                max_delay=settings.agent_retry_max_delay, backoff_factor=2.0, jitter=True),
            ToolErrorMiddleware(on_error=_on_tool_error),
            ToolRetryMiddleware(max_retries=settings.agent_max_retries, retry_on=is_transient_error,
                on_failure="error", initial_delay=settings.agent_retry_initial_delay if retry_delay is None else retry_delay,
                max_delay=settings.agent_retry_max_delay, backoff_factor=2.0, jitter=True),
        ],
    )


def graph(config: RunnableConfig):
    """Agent Server 官方图工厂：模型延迟构建，不额外安装 checkpointer。"""
    return create_lma_agent(_get_llm())
