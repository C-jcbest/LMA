"""从本轮已完成的回答建立测点关联，不生成或推测业务结论。"""

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

from app.agent.report import report_in_last_turn


def investigation_record(messages: list[BaseMessage]) -> dict | None:
    question_index = next((
        index for index in range(len(messages) - 1, -1, -1)
        if isinstance(messages[index], HumanMessage)
    ), None)
    if question_index is None:
        return None
    question = messages[question_index]
    turn = messages[question_index + 1:]
    report = report_in_last_turn(messages)
    names: set[str] = set()
    report_call_id = None
    if report is not None:
        report_call_id, data = report
        names.update(station["station_name"] for station in data["stations"])
        anchor_id = report_call_id
    else:
        answer = next((
            message for message in reversed(turn)
            if isinstance(message, AIMessage) and not message.tool_calls and message.text.strip()
        ), None)
        if answer is None or not answer.id:
            return None
        anchor_id = answer.id
        focus = question.additional_kwargs.get("lma_context", {}).get("focus_station")
        if focus:
            names.add(focus)
        for message in turn:
            if not isinstance(message, ToolMessage) or message.status == "error" or not isinstance(message.artifact, dict):
                continue
            artifact = message.artifact
            data = artifact.get("data", {})
            name = None
            if artifact.get("kind") in {"gnss_series", "vision", "numerical"}:
                name = data.get("station_name")
            elif artifact.get("kind") == "weather":
                name = data.get("location", {}).get("station_name")
            elif artifact.get("kind") == "site_environment":
                name = data.get("center_station", {}).get("station_name")
            if name:
                names.add(name)
    if not names:
        return None
    return {
        "anchor_id": anchor_id,
        "report_tool_call_id": report_call_id,
        "station_names": sorted(names),
        "question": question.text[:300],
    }
