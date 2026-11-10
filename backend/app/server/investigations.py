"""从真实本轮证据或用户选择建立UUID关联；自然回答不产生已验证业务状态。"""
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

from app.agent.report import report_in_last_turn


def station_identities(messages):
    stations = {}
    for message in messages:
        if not isinstance(message, ToolMessage) or not isinstance(message.artifact, dict):
            continue
        artifact = message.artifact
        if message.status == 'error' and artifact.get('kind') != 'acquisition_failure':
            continue
        data = artifact.get('data', {})
        if artifact.get('kind') in {'gnss_series', 'vision', 'numerical', 'acquisition_failure'}:
            station = data
        elif artifact.get('kind') == 'weather':
            station = data.get('location', {})
        elif artifact.get('kind') == 'site_environment':
            station = data.get('center_station', {})
        elif artifact.get('kind') == 'investigation_report':
            for station in data.get('stations', []):
                if station.get('station_uuid'):
                    stations[station['station_uuid']] = station['station_name']
            continue
        else:
            continue
        if station.get('station_uuid') and station.get('station_name'):
            stations[str(station['station_uuid'])] = station['station_name']
        for identifier, name in data.get('comparisons', {}).get('station_names', {}).items():
            stations[str(identifier)] = name
    return stations


def investigation_record(messages: list[BaseMessage], focused_station=None):
    question_index = next((index for index in range(len(messages) - 1, -1, -1) if isinstance(messages[index], HumanMessage)), None)
    if question_index is None:
        return None
    question = messages[question_index]
    turn = messages[question_index + 1:]
    report = report_in_last_turn(messages)
    report_call_id = None
    if report is not None:
        report_call_id, data = report
        stations = {station['station_uuid']: station['station_name'] for station in data['stations']}
        anchor_id = report_call_id
    else:
        answer = next((message for message in reversed(turn) if isinstance(message, AIMessage) and not message.tool_calls and message.text.strip()), None)
        if answer is None or not answer.id:
            return None
        anchor_id = answer.id
        stations = station_identities(turn)
        context = question.additional_kwargs.get('lma_context', {})
        focus = focused_station or context.get('focus_identity')
        if focus:
            stations[focus['station_uuid']] = focus['station_name']
    if not stations:
        return None
    return {
        'anchor_id': anchor_id, 'report_tool_call_id': report_call_id,
        'stations': [{'station_uuid': identifier, 'station_name': name} for identifier, name in sorted(stations.items())],
        'question': question.text[:300],
    }
