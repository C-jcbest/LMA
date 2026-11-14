"""同一会话里条件完全相同的取数直接指回已有依据，不再执行、不新建卡片、不占查询额度。

模型有时会把同一窗口取两次（例如先取长期背景，调查中途又取一遍）。数据层有缓存所以不贵，
但它仍多一次往返、多一张重复卡片，还占用本轮查询次数。这条规则由工具层保证，提示词不必再写。
"""

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, ToolMessage

from app.agent.message_context import evidence_id, is_evidence

# 只对访问外部数据的工具去重；计算和结论登记每次的意图不同。
DEDUPLICATED_TOOL_NAMES = frozenset({
    "find_stations", "get_station_overview", "get_displacement", "query_weather", "inspect_site_environment",
})
DUPLICATE_MARKER = "lma_duplicate_of"


def _previous_results(messages) -> dict[tuple[str, str], str]:
    """(工具名, 参数) → 已成功取得的依据所在的工具调用 ID。"""
    calls = {}
    for message in messages:
        if isinstance(message, AIMessage):
            for call in message.tool_calls:
                calls[call["id"]] = call
    results = {}
    for message in messages:
        if not isinstance(message, ToolMessage) or not is_evidence(message):
            continue
        if message.artifact.get("status") == "error":
            continue
        call = calls.get(message.tool_call_id)
        if call is not None and call["name"] in DEDUPLICATED_TOOL_NAMES:
            results[(call["name"], _arguments_key(call["args"]))] = message.tool_call_id
    return results


def _arguments_key(arguments: dict) -> str:
    # 参数是模型给出的 JSON 对象；按键排序后比较，值的顺序（如对比测点列表）仍有意义。
    return repr(sorted(arguments.items()))


def duplicate_calls(messages) -> list[tuple[dict, str]]:
    """最新一条模型回复里与此前结果条件完全相同的调用，以及对应的已有工具调用 ID。"""
    latest = messages[-1] if messages else None
    if not isinstance(latest, AIMessage) or not latest.tool_calls:
        return []
    previous = _previous_results(messages[:-1])
    duplicates = []
    for call in latest.tool_calls:
        original = previous.get((call["name"], _arguments_key(call["args"])))
        if original is not None:
            duplicates.append((call, original))
    return duplicates


def answered_duplicate_call_ids(messages) -> set[str]:
    """最新一条模型回复之后、已由去重答复的工具调用 ID；查询额度据此不计这些调用。"""
    answered = set()
    for message in reversed(messages):
        if isinstance(message, AIMessage):
            break
        if isinstance(message, ToolMessage) and message.additional_kwargs.get(DUPLICATE_MARKER):
            answered.add(message.tool_call_id)
    return answered


class DuplicateQueryMiddleware(AgentMiddleware):
    """在工具执行前答复重复调用；官方工具节点不会再执行已有 ToolMessage 的调用。

    必须排在查询额度中间件之后（after_model 按注册顺序倒序执行），这样额度统计时能看到哪些调用已被答复。
    """

    async def aafter_model(self, state, runtime):
        duplicates = duplicate_calls(state["messages"])
        if not duplicates:
            return None
        return {"messages": [
            ToolMessage(
                content=(
                    f"本会话已取得条件完全相同的结果，依据编号 {evidence_id(original)}，直接引用即可；"
                    "需要更新数据时请调整时间窗口。"
                ),
                tool_call_id=call["id"],
                name=call["name"],
                additional_kwargs={DUPLICATE_MARKER: evidence_id(original)},
            )
            for call, original in duplicates
        ]}
