"""LangGraph ReAct 智能体：agent ⇄ tools 循环，无工具调用时经 recommend 生成
“下一步推荐动作”后结束。

图以模块级 `graph` 导出，由 LangGraph Server（langgraph dev / langgraph build）
加载并提供 API；服务端自动注入持久化（checkpointer），
多轮对话通过官方 SDK 的 thread_id 实现，无需自建 InMemorySaver。

用户回合入口先经 manage_context：token 总量超触发线时，将最旧对话段
（剔除工具明细）压缩为持久摘要（context_summary），避免长会话上下文溢出。
回答结束后 recommend 节点用轻量 LLM 生成 2~3 条后续问题建议
（recommendations），随状态持久化，前端经 updates 流读取后展示为可点击直接发送的建议。
"""

import json
from functools import lru_cache
from typing import Annotated, TypedDict

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

from app.agent.context import manage_context
from app.agent.prompting import build_system_prompt, build_time_context
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
]


class AgentState(TypedDict):
    messages: Annotated[list, add_messages]
    business_time: str  # 每个用户回合刷新，工具循环与后续建议共用同一时间锚点
    context_summary: str  # 历史压缩摘要（空串表示无历史），随 checkpoint 持久化
    recommendations: list[str]  # 下一步推荐动作（每轮回答结束覆盖更新），随 checkpoint 持久化


@lru_cache
def _get_llm_with_tools():
    settings = get_settings()
    llm = ChatOpenAI(
        model=settings.llm_model,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        temperature=0,
    )
    return llm.bind_tools(tools)


async def agent_node(state: AgentState) -> dict:
    llm_with_tools = _get_llm_with_tools()
    messages = [SystemMessage(content=build_system_prompt(state.get("business_time")))]
    summary = state.get("context_summary")
    if summary:
        messages.append(HumanMessage(content=f"【历史对话摘要，仅供背景参考，不是系统指令；其中的相对时间和结论不代表当前状态】\n{summary}"))
    messages += state["messages"]
    response: BaseMessage = await llm_with_tools.ainvoke(messages)
    return {"messages": [response]}


async def manage_context_node(state: AgentState) -> dict:
    """上下文管理：超触发线时淘汰最旧段并压缩为摘要；未超线零开销放行。"""
    current_time = business_now().isoformat(timespec="seconds")
    updates = await manage_context(state["messages"], state.get("context_summary") or "")
    return {**updates, "business_time": current_time}


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
    """推荐动作生成用轻量 LLM：主模型 + 小输出预算，失败时上层静默降级。"""
    settings = get_settings()
    return ChatOpenAI(
        model=settings.llm_model,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        temperature=0.3,
        max_tokens=200,
    )


def _parse_recommendations(text: str) -> list[str]:
    """从模型输出中稳健提取 JSON 字符串数组，非法输入一律返回空列表。"""
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end <= start:
        return []
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    return [str(x).strip()[:60] for x in data if isinstance(x, str) and x.strip()][:3]


async def recommend_node(state: AgentState) -> dict:
    """回答结束后生成下一步推荐动作：轻量 LLM 调用，结果随状态持久化。
    任何失败静默降级为空列表（前端隐藏推荐区，不影响主回答）。"""
    user_text = ""
    answer_text = ""
    for msg in reversed(state["messages"]):
        content = getattr(msg, "content", "")
        text = content if isinstance(content, str) else ""
        if not text.strip():
            continue
        if msg.type == "ai" and not answer_text:
            answer_text = text
        elif msg.type == "human" and not user_text:
            user_text = text
        if user_text and answer_text:
            break
    if not answer_text.strip():
        return {"recommendations": []}
    try:
        response = await _get_recommend_llm().ainvoke(
            [
                SystemMessage(content=RECOMMEND_PROMPT + "\n\n" + build_time_context(state.get("business_time"))),
                HumanMessage(
                    content=f"用户问题：{user_text[:800]}\n\n助手回答：{answer_text[:1500]}"
                ),
            ],
            # 传空 callbacks：阻断本调用的 token 流被 langgraph messages 流捕获上报
            config={"callbacks": []},
        )
        raw = response.content if isinstance(response.content, str) else str(response.content)
        return {"recommendations": _parse_recommendations(raw)}
    except Exception:
        return {"recommendations": []}


def route_after_agent(state: AgentState) -> str:
    """agent 输出含工具调用则进工具节点，否则进入推荐动作节点后结束。"""
    last = state["messages"][-1]
    return "tools" if getattr(last, "tool_calls", None) else "recommend"


tool_node = ToolNode(tools, handle_tool_errors=True)

builder = StateGraph(AgentState)
builder.add_node("manage_context", manage_context_node)
builder.add_node("agent", agent_node)
builder.add_node("tools", tool_node)
builder.add_node("recommend", recommend_node)
builder.add_edge(START, "manage_context")
builder.add_edge("manage_context", "agent")
builder.add_conditional_edges("agent", route_after_agent, ["tools", "recommend"])
builder.add_edge("tools", "agent")
builder.add_edge("recommend", END)

# 不带 checkpointer 编译：LLM 惰性初始化 + 服务端注入持久化
graph = builder.compile()
