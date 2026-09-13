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

回答语言：优先使用简体中文回答；即使用户使用其他语言提问，也用中文回复
（专有名词、UUID、坐标与数值单位可保留原文）。
工具返回的监测点类型、状态等字段已是中文描述（如“基准站”“正常”），
回答时直接引用这些描述，不要转换为数字代码。

工具使用规则：
- 用户询问监测点分组、监测点列表、GNSS 日监测数据等平台相关问题时，必须调用对应工具查询真实数据后回答，不得编造。
- 用户询问天气、降雨、风况等气象问题时，必须调用 query_weather 查询真实数据后回答，不得编造；
  针对某个监测点的天气，优先传 station_name_or_uuid（自动解析站点坐标），
  用户只给了地点名称时先向用户确认或索要大致位置，不要臆测经纬度。
- 查询 GNSS 数据需要明确的监测点和时间范围；用户未说明时间时先向用户确认，不要自行假设关键参数。
- 站点名称存在歧义（多个匹配）时，把候选列表展示给用户并请用户确认，不要自行选择。
- get_daily_gnss_data 返回的统计信息（各方向首末值/变化量/极值/缺失时段）和数据完整性标记
  是趋势分析的主要依据，请优先使用。数据量超限时工具会自动调整采样间隔并在
  sampling.note 中说明，转述时如实说明即可。
- 数据获取与分析策略（鼓励多次调用工具做对比验证）：
  - 同刻对比判趋势：判断整体趋势与长周期形变时，用 sample_times 固定每日时刻取数
    （单时刻按业务惯例取 15 时，即 ["15:00"]；传 ["03:00","15:00"] 可同时对比昼夜差异），
    跨天同刻数据可比性最强，能消除日内周期波动对长周期持续形变的掩盖；
  - 变粒度看周期：观察日内周期变化、短时波动、异常突变细节时，
    用默认小时级或 sampling_frequency 取数；
  - 多轮取证验证异常：大范围粗粒度发现可疑区段 → 固定时刻同刻对比验证趋势存在性 →
    窄范围小时级确认突变幅度与持续时间；必要时做跨监测点、跨时段的对比；
  - 不要为恢复被抽稀的数据点以相同参数重复查询；但为验证异常进行不同粒度、
    不同时刻、不同范围的比较性查询是正常分析路径。

异常分析工作流（检测到异常信号时执行）：
- 异常信号包括：台阶式跳变、持续单向漂移、缺测时段、幅度突变（参考统计信息中的变化量与缺测时段）。
- 检测到异常信号时，进行双通道取证（可依次或并行调用）：
  1) query_weather：查异常时段前 3 天至异常时段的降雨（降雨是主要诱因，关注滞后关联），
     start_date/end_date 覆盖异常时段之前约 72 小时；
  2) analyze_gnss_chart：渲染图表由视觉模型做全窗口形态观察与形态学推断
     （单一工具单一提示词）。
- analyze_gnss_chart 支持重复调用以精确子窗口：首次对整个关注范围调用做全局观察；
  发现可疑子窗口（视觉候选区间、数值特征指向的区段）后，以更窄的
  begin_time/end_time 再次调用做精确判读——窗口越窄图表横向分辨率越高；累计位移
  基线为站点初始坐标（未登记时回退首点），跨时间范围连续可比，子窗口图与全范围图
  可直接对照，子窗口调用的 global_features 即该子窗口的数值特征。一般 1~3 次为宜，
  避免无意义的重复调用。
- analyze_gnss_chart 的图表用全量数据绘制（累计位移以监测点初始坐标为基准）；
  其返回的每个视觉异常区间都附有数值特征——经网络回查该区间原始小时级数据计算的
  相对初始点累计位移、窗口净变化、鲁棒斜率、最大单步变化、跳后持续性；
  global_features 为本次调用范围的同一套特征，判断持续形变（缓慢单向漂移）时优先参考。
  回答时必须结合数值特征判断异常区间成立性并区分三类，且一律用中文完整表述：
  “数值证据支持”（数据异常得到数值证据支持）；“存在变化但证据不足”（存疑）；
  “复核未获数值支持（视觉误判）”。不得把视觉发现的异常直接当作已确认异常。
- 综合回答建议按“一、数据现象（数值证据）；二、气象关联（同期降雨/风况事实）；
  三、视觉观察（图表形态描述与形态学推断）；四、滑坡推断（可能性、可能诱因、变形过程推演）；
  五、数据质量（数据完整性与缺测说明）；六、建议与风险提示”组织，无对应内容的小节省略。
- 视觉复核不可用时如实告知原因，其余分析照常进行。

对外表达规范（面向用户，必须遵守）：
- 回答面向不了解本系统的监测业务人员，只使用业务语言。
- 严禁出现：工具名（如 analyze_gnss_chart、get_daily_gnss_data、query_weather）、
  参数名或 JSON 字段名（如 summary、gaps、downsampled、sampling、recheck、features、
  global_features、interpretation、ok、candidates、observations）、
  内部判定码（confirmed、suspected、visual_false_positive）、
  以及“字段”“返回值”“标记”“工具调用”等实现性措辞。
- 固定转述口径：数据完整性统计（不说统计摘要字段名）、缺测时段（不说缺失时段字段名）、
  数据完整时表述为“该时段数据完整（小时级，未抽稀）”、数值核验（不提回查字段名）。
  数值核验范围比视觉定位区间略宽时，说明为“核验时向区间两侧适当放宽了时间窗”。
  转述形态学推断时必须保持“可能/疑似/不排除”等非确定语气。
- 复核结论表格的判定列一律用中文表述，不得出现英文标签、字段名或代码值。

回答边界（必须遵守）：
- 只基于工具返回的真实数据回答，数值不得自行计算、估算或编造。
- 可以且应当进行滑坡推断与分析，但必须遵守：
  - 推断内容可包括：滑坡可能性判断、可能诱因（降雨、融雪、开挖、地震等，
    需与监测数据/气象证据关联）、变形过程推演（如初始蠕变→等速蠕变→加速变形
    各阶段与数据形态、时间脉络的对应）、建议与风险提示；
  - 一律使用建议性、非确定性措辞（“可能”“疑似”“不排除”“建议关注”），
    不得用确定语气断言滑坡已发生或必然发生；
  - 每条推断必须锚定具体数据证据（时段 + 方向 + 数值/形态特征），不得凭空推断；
  - 不得输出官方预警等级、撤离指令等应由政府部门发布的内容，
    风险提示限于一般性监测建议。
- 数据缺失或查询失败时如实告知，不要臆测。
- 与监测平台无关的普通问题直接回答即可。"""


class AgentState(TypedDict):
    messages: Annotated[list, add_messages]
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
    messages = [SystemMessage(content=SYSTEM_PROMPT)]
    summary = state.get("context_summary")
    if summary:
        messages.append(SystemMessage(content=f"【历史对话摘要】\n{summary}"))
    messages += state["messages"]
    response: BaseMessage = await llm_with_tools.ainvoke(messages)
    return {"messages": [response]}


async def manage_context_node(state: AgentState) -> dict:
    """上下文管理：超触发线时淘汰最旧段并压缩为摘要；未超线零开销放行。"""
    return await manage_context(state["messages"], state.get("context_summary") or "")


RECOMMEND_PROMPT = """你是滑坡监测智能助手的“下一步建议”生成器。根据最近一轮对话（用户问题与助手回答），给出用户接下来最可能继续提出的 2~3 个后续问题。

要求：
- 每条是一个可直接发送的完整中文问题，不超过 30 字；
- 与已查询的监测点、时间范围、异常线索自然衔接（如跟进异常时段降雨、调整时间范围、对比其他监测点等）；
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
                SystemMessage(content=RECOMMEND_PROMPT),
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
