"""LangGraph ReAct 智能体：agent ⇄ tools 循环，无工具调用时经 recommend 生成
“下一步推荐动作”后结束。

图以模块级 `graph` 导出，由 LangGraph Server（langgraph dev / langgraph build）
加载并提供 API；服务端自动注入持久化（checkpointer），
多轮对话通过官方 SDK 的 thread_id 实现，无需自建 InMemorySaver。

用户回合入口先经 manage_context：token 总量超触发线时，将最旧对话段
（剔除工具明细）压缩为持久摘要（context_summary），避免长会话上下文溢出。
最终回答完成后，由 recommend 节点生成 2~3 条后续问题建议。建议随状态持久化，
前端经 updates 流读取后展示。
"""

import json
import logging
from functools import lru_cache
from time import perf_counter
from typing import Annotated, TypedDict

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI
from langgraph.errors import NodeError
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.types import RetryPolicy

from app.agent.context import SUMMARY_CONTEXT_PREFIX, build_context_budget, manage_context
from app.agent.prompting import build_system_prompt, build_time_context
from app.agent.retry import is_transient_error
from app.agent.reasoning import ReasoningChatOpenAI, thinking_options
from app.agent.site import inspect_site_environment
from app.business_time import business_now
from app.agent.tools import get_daily_gnss_data, list_station_groups, list_stations
from app.agent.vision import analyze_gnss_chart
from app.agent.weather import query_weather
from app.config import get_settings

tools = [
    list_station_groups,
    list_stations,
    get_daily_gnss_data,
    query_weather,
    analyze_gnss_chart,
    inspect_site_environment,
]

logger = logging.getLogger(__name__)


class AgentState(TypedDict):
    messages: Annotated[list, add_messages]
    business_time: str  # 每个用户回合刷新，工具循环与后续建议共用同一时间锚点
    context_summary: str  # 历史压缩摘要（空串表示无历史），随 checkpoint 持久化
    recommendations: list[str]  # 下一步推荐动作（每轮回答结束覆盖更新），随 checkpoint 持久化
    recommendations_error: str  # 推荐生成或结构校验失败时的可见错误
    context_usage: dict  # 完整输入预算与最近一次模型实际 usage，供前端展示


@lru_cache
def _get_llm_with_tools():
    settings = get_settings()
    llm = ReasoningChatOpenAI(
        model=settings.llm_model,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        temperature=0,
        **thinking_options(settings.llm_thinking),
    )
    return llm.bind_tools(tools)


async def agent_node(state: AgentState) -> dict:
    llm_with_tools = _get_llm_with_tools()
    system_prompt = build_system_prompt(state.get("business_time"))
    messages = [SystemMessage(content=system_prompt)]
    summary = state.get("context_summary")
    if summary:
        messages.append(HumanMessage(content=SUMMARY_CONTEXT_PREFIX + summary))
    messages += state["messages"]
    budget = build_context_budget(
        state["messages"],
        summary or "",
        system_prompt=system_prompt,
        bound_tools=tools,
    )
    started_at = perf_counter()
    response: BaseMessage = await llm_with_tools.ainvoke(messages)
    elapsed_ms = max(0, round((perf_counter() - started_at) * 1000))
    response = response.model_copy(
        update={
            "additional_kwargs": {
                **response.additional_kwargs,
                # 使用模型响应返回后的服务端真实时间；前端不自行补造消息时间。
                "created_at": business_now().isoformat(timespec="seconds"),
            }
        }
    )
    reasoning_content = (
        response.additional_kwargs.get("reasoning_content")
        or response.additional_kwargs.get("reasoning")
        or response.additional_kwargs.get("thinking")
        or response.response_metadata.get("reasoning_content")
    )
    if isinstance(reasoning_content, str) and reasoning_content.strip():
        response = response.model_copy(
            update={
                "additional_kwargs": {
                    **response.additional_kwargs,
                    "reasoning_content": reasoning_content,
                    "lma_thinking_duration_ms": elapsed_ms,
                }
            }
        )
    usage = getattr(response, "usage_metadata", None) or {}
    input_tokens = usage.get("input_tokens")
    updates: dict = {"messages": [response]}
    if isinstance(input_tokens, int) and input_tokens >= 0:
        updates["context_usage"] = budget.usage_snapshot(usage)
    else:
        logger.warning("model response did not include input token usage; preserve previous context_usage")

    return updates


async def manage_context_node(state: AgentState) -> dict:
    """上下文管理：超触发线时淘汰最旧段并压缩为摘要；未超线零开销放行。"""
    current_time = business_now().isoformat(timespec="seconds")
    updates = await manage_context(
        state["messages"],
        state.get("context_summary") or "",
        system_prompt=build_system_prompt(current_time),
        bound_tools=tools,
    )
    message_updates = list(updates.get("messages", []))
    if state["messages"] and state["messages"][-1].type == "human":
        current_message = state["messages"][-1]
        message_updates.append(
            current_message.model_copy(
                update={
                    "additional_kwargs": {
                        **current_message.additional_kwargs,
                        # 覆盖客户端可能携带的值，确保展示时间来自服务端。
                        "created_at": current_time,
                    }
                }
            )
        )
    return {
        **updates,
        **({"messages": message_updates} if message_updates else {}),
        "business_time": current_time,
        # 新回合开始先清除上轮推荐，避免在新回答完成前误展示旧项。
        "recommendations": [],
        "recommendations_error": "",
    }


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
                        f"用户问题：{user_text[:800]}\n\n"
                        f"助手回答：{answer_text[:1500]}"
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


async def recommend_node(state: AgentState) -> dict:
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


def route_after_agent(state: AgentState) -> str:
    """agent 输出含工具调用则继续调查，否则生成建议后结束。"""
    last = state["messages"][-1]
    return "tools" if getattr(last, "tool_calls", None) else "recommend"


def _handle_tool_error(exc: Exception) -> str:
    """业务错误交还模型；瞬时错误上抛给 LangGraph RetryPolicy。"""
    if is_transient_error(exc):
        raise exc
    logger.warning(
        "tool execution failed without retry: %s",
        type(exc).__name__,
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    message = str(exc).strip()
    return f"工具执行失败：{message[:300] if message else type(exc).__name__}"


def _tool_retry_exhausted(state: AgentState, error: NodeError) -> dict:
    """重试耗尽后补齐 ToolMessage，让智能体说明降级而不是中断整轮。"""
    last = state["messages"][-1]
    calls = getattr(last, "tool_calls", None) or []
    error_type = type(error.error).__name__
    logger.warning(
        "tool retries exhausted: %s",
        error_type,
        exc_info=(type(error.error), error.error, error.error.__traceback__),
    )
    return {
        "messages": [
            ToolMessage(
                content=f"外部数据服务连续重试后仍不可用（{error_type}），请基于已有证据回答并说明限制。",
                tool_call_id=call["id"],
                name=call.get("name"),
            )
            for call in calls
        ]
    }


tool_node = ToolNode(tools, handle_tool_errors=_handle_tool_error)
tool_retry_policy = RetryPolicy(
    max_attempts=3,
    initial_interval=0.5,
    backoff_factor=2.0,
    jitter=True,
    retry_on=is_transient_error,
)

builder = StateGraph(AgentState)
builder.add_node("manage_context", manage_context_node)
builder.add_node("agent", agent_node)
builder.add_node(
    "tools",
    tool_node,
    retry_policy=tool_retry_policy,
    error_handler=_tool_retry_exhausted,
)
builder.add_node("recommend", recommend_node)
builder.add_edge(START, "manage_context")
builder.add_edge("manage_context", "agent")
builder.add_conditional_edges("agent", route_after_agent, ["tools", "recommend"])
builder.add_edge("tools", "agent")
builder.add_edge("recommend", END)

# 不带 checkpointer 编译：LLM 惰性初始化 + 服务端注入持久化
graph = builder.compile()
