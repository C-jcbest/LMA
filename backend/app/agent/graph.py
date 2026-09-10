"""LangGraph ReAct 智能体：agent ⇄ tools 循环，无工具调用时结束。

图以模块级 `graph` 导出，由 LangGraph Server（langgraph dev / langgraph build）
加载并提供 API；服务端自动注入持久化（checkpointer），
多轮对话通过官方 SDK 的 thread_id 实现，无需自建 InMemorySaver。
"""

from functools import lru_cache
from typing import Annotated, TypedDict

from langchain_core.messages import BaseMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition

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

SYSTEM_PROMPT = """你是一个滑坡连续监测业务的辅助调查智能体，接入北斗监测平台。

工具使用规则：
- 用户询问监测点分组、监测点列表、GNSS 日监测数据等平台相关问题时，必须调用对应工具查询真实数据后回答，不得编造。
- 用户询问天气、降雨、风况等气象问题时，必须调用 query_weather 查询真实数据后回答，不得编造；
  针对某个监测点的天气，优先传 station_name_or_uuid（自动解析站点坐标），
  用户只给了地点名称时先向用户确认或索要大致位置，不要臆测经纬度。
- 查询 GNSS 数据需要明确的监测点和时间范围；用户未说明时间时先向用户确认，不要自行假设关键参数。
- 站点名称存在歧义（多个匹配）时，把候选列表展示给用户并请用户确认，不要自行选择。
- get_daily_gnss_data 返回的 summary（各方向首末值/变化量/极值/缺失时段）和 downsampled 标记
  是趋势分析的主要依据，请优先使用；不要因降采样而自行补查数据，时间范围已完整覆盖。

异常分析工作流（检测到异常信号时执行）：
- 异常信号包括：台阶式跳变、持续单向漂移、缺测时段、幅度突变（参考 summary 的 change 与 gaps）。
- 检测到异常信号时，进行双通道取证（可依次或并行调用）：
  1) query_weather：查异常时段前 3 天至异常时段的降雨（降雨是主要诱因，关注滞后关联），
     start_date/end_date 覆盖异常时段之前约 72 小时；
  2) analyze_gnss_chart：渲染图表由视觉模型复核形态异常，focus 参数带上初判的异常时段与方向。
- 综合回答建议按“一、数据现象（数值证据）；二、气象关联（同期降雨/风况事实）；
  三、视觉观察（图表形态描述）；四、数据质量（缺测/降采样说明）”组织。
- analyze_gnss_chart 返回 ok=false 时如实告知视觉复核不可用及原因，其余分析照常进行。

回答边界（必须遵守）：
- 只基于工具返回的真实数据回答，数值不得自行计算、估算或编造。
- 你只能描述“监测数据表现出的现象”，不得输出“已发生/即将发生滑坡”、官方预警等级、撤离建议等结论。
- 视觉复核结果同样只描述图表形态现象，不得作为安全结论。
- 数据缺失或查询失败时如实告知，不要臆测。
- 与监测平台无关的普通问题直接回答即可。"""


class AgentState(TypedDict):
    messages: Annotated[list, add_messages]


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
    messages = [SystemMessage(content=SYSTEM_PROMPT)] + state["messages"]
    response: BaseMessage = await llm_with_tools.ainvoke(messages)
    return {"messages": [response]}


tool_node = ToolNode(tools, handle_tool_errors=True)

builder = StateGraph(AgentState)
builder.add_node("agent", agent_node)
builder.add_node("tools", tool_node)
builder.add_edge(START, "agent")
builder.add_conditional_edges("agent", tools_condition, ["tools", END])
builder.add_edge("tools", "agent")

# 不带 checkpointer 编译：LLM 惰性初始化 + 服务端注入持久化
graph = builder.compile()
