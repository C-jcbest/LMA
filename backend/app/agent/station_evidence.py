"""按测点归集会话中的依据：结论登记校验与测点调查记录共用同一套身份规则。"""

from dataclasses import dataclass, field

from langchain_core.messages import BaseMessage, ToolMessage

from app.agent.message_context import evidence_id, is_evidence


@dataclass
class StationEvidence:
    station_name: str
    evidence_ids: list[str] = field(default_factory=list)
    # 成功取得位移数据的窗口 (begin, end)，用于判断结论窗口是否有数据支撑。
    displacement_windows: list[tuple[str, str]] = field(default_factory=list)
    failed: bool = False


def evidence_by_station(messages: list[BaseMessage]) -> dict[str, StationEvidence]:
    stations: dict[str, StationEvidence] = {}

    def entry(station_uuid, station_name) -> StationEvidence | None:
        if not station_uuid or not station_name:
            return None
        return stations.setdefault(str(station_uuid), StationEvidence(station_name))

    for message in messages:
        if not isinstance(message, ToolMessage) or not is_evidence(message):
            continue
        artifact = message.artifact
        data = artifact.get("data", {})
        kind = artifact.get("kind")
        identifier = evidence_id(message.tool_call_id)
        succeeded = artifact.get("status") != "error"
        if kind in {"gnss_series", "vision"}:
            item = entry(data.get("station_uuid"), data.get("station_name"))
            if item is None:
                continue
            item.evidence_ids.append(identifier)
            if succeeded and data.get("points", data.get("chart_points")):
                item.displacement_windows.append((data["begin_time"], data["end_time"]))
            # 同组对比中的测点也取得了同一窗口的数据。
            comparisons = data.get("comparisons", {})
            for other_uuid, other_name in comparisons.get("station_names", {}).items():
                if other_uuid == data.get("station_uuid") or other_uuid in comparisons.get("failures", {}):
                    continue
                other = entry(other_uuid, other_name)
                other.evidence_ids.append(identifier)
                if succeeded and comparisons.get("snapshots", {}).get(other_uuid):
                    other.displacement_windows.append((data["begin_time"], data["end_time"]))
        elif kind == "acquisition_failure":
            item = entry(data.get("station_uuid"), data.get("station_name"))
            if item is not None:
                item.evidence_ids.append(identifier)
                item.failed = True
        elif kind == "weather":
            location = data.get("location", {})
            item = entry(location.get("station_uuid"), location.get("station_name"))
            if item is not None:
                item.evidence_ids.append(identifier)
        elif kind == "site_environment":
            center = data.get("center_station", {})
            item = entry(center.get("station_uuid"), center.get("station_name"))
            if item is not None:
                item.evidence_ids.append(identifier)
    for item in stations.values():
        item.evidence_ids = list(dict.fromkeys(item.evidence_ids))
    return stations
