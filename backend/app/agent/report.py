"""调查简报：把事实、分析、推断分层从提示词约定变成服务端校验的数据结构。"""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from uuid import UUID
from typing import Literal

from langchain.tools import ToolRuntime, tool
from langchain_core.messages import BaseMessage, HumanMessage, ToolMessage
from pydantic import BaseModel, ConfigDict, Field

from app.agent.message_context import evidence_id, is_evidence
from app.agent.tool_protocol import ToolFailure, tool_result

REPORT_TOOL_NAME = "submit_investigation_report"

class EvidenceSupport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    evidence_id: str = Field(description="所引用工具结果末尾lma_evidence标记中的编号；不是持久化证据UUID")
    station_uuid: UUID
    begin_time: datetime | None = None
    end_time: datetime | None = None
    axis: Literal["n", "e", "u", "h", "d"] | None = Field(default=None, description="数值变化、趋势或跳变指定方向n/e/u或合成量h/d；数据质量无需指定")
    scope: Literal["window", "common_period", "first_window", "second_window"] = "window"
    weather_period: Literal["history", "forecast", "current"] | None = None
    weather_variable: str | None = Field(default=None, max_length=80, description="气象判断实际引用的字段，如precipitation_sum或wind_speed_10m")
    claim: Literal["numeric_change", "trend", "jump", "data_quality", "weather", "site", "unavailable"] = Field(
        description="numeric_change/trend/jump只能引用独立数值工具；data_quality也可引用GNSS或视觉的覆盖与缺测；weather/site引用对应工具",
    )
    rationale: str = Field(min_length=1, max_length=500)


class ReportStation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    station_uuid: UUID
    begin_time: datetime
    end_time: datetime
    supports: list[EvidenceSupport] = Field(min_length=1, max_length=12, description="本测点本问题的适用事实；不足和失败也须对应真实证据")
    station_name: str = Field(min_length=1, max_length=80, description="测点名称，使用工具结果中的原始名称")
    status: Literal["未见明显变化", "持续关注", "需人工复核", "数据不足", "暂无法分析"] = Field(
        description=(
            "未见明显变化：现有数据未显示值得关注的变化；"
            "持续关注：存在持续或同向变化，尚无突变或加速迹象，建议继续观察；"
            "需人工复核：出现突变、疑似加速或证据相互矛盾，需要人工进一步确认；"
            "数据不足：取得了数据，但覆盖范围或质量不足以判断；"
            "暂无法分析：未能取得可用数据"
        ),
    )
    reason: str = Field(min_length=1, max_length=200, description="得到该调查状态的一句话原因")
    acceleration: Literal["未见持续加速", "疑似加速", "无法判断"] | None = Field(
        default=None, description="涉及加速判断时提供；与当前问题无关时省略，必要限制写入原因",
    )
    data_quality: str = Field(default="", max_length=120, description="影响结论的数据覆盖或缺测情况；无必要补充时省略")



def _business_time(value: datetime | str) -> datetime:
    moment = datetime.fromisoformat(value) if isinstance(value, str) else value
    if moment.tzinfo is not None:
        moment = moment.astimezone(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None)
    return moment


def _validate_support(support: EvidenceSupport, artifact: dict) -> str:
    """校验对象、证据种类及实际覆盖；不尝试用关键词替代专业语义判断。"""
    data = artifact["data"]
    if support.claim == "data_quality" and support.scope != "window":
        raise ToolFailure("数据质量引用本测点完整查询窗口，不能套用共同样本或分窗范围")
    if artifact.get("status") == "error" and support.claim not in {"data_quality", "unavailable"}:
        raise ToolFailure("失败证据只能说明缺失或限制，不能支持成功数值判断")
    if support.claim == "unavailable":
        if artifact["kind"] != "acquisition_failure":
            raise ToolFailure("未取得数据必须引用对应查询失败，而非其他站的结果或台账")
        if data.get("station_uuid") != str(support.station_uuid):
            raise ToolFailure("失败查询与测点UUID不一致")
        if support.begin_time is None or support.end_time is None:
            raise ToolFailure("失败查询须说明目标窗口")
        if _business_time(support.begin_time) != _business_time(data["begin_time"]) or _business_time(support.end_time) != _business_time(data["end_time"]):
            raise ToolFailure("失败查询与目标窗口不一致")
        return data["station_name"]
    identity = data
    if support.claim == "site":
        if artifact["kind"] != "site_environment":
            raise ToolFailure("场地判断需要场地证据")
        identity = data["center_station"]
    elif support.claim == "weather":
        if artifact["kind"] != "weather":
            raise ToolFailure("气象判断需要天气证据")
        identity = data["location"]
    elif support.claim == "data_quality" and artifact["kind"] in {"gnss_series", "vision"}:
        if support.scope != "window":
            raise ToolFailure("原始数据质量仅支持该查询窗口")
    elif artifact["kind"] != "numerical":
        raise ToolFailure("数值判断需要独立数值分析证据")
    elif support.scope == "common_period":
        names = data.get("comparisons", {}).get("station_names", {})
        name = names.get(str(support.station_uuid))
        if name is None:
            raise ToolFailure("该测点不在共同有效时段比较中")
        identity = {"station_uuid": str(support.station_uuid), "station_name": name}
    if identity.get("station_uuid") != str(support.station_uuid):
        raise ToolFailure("判断测点UUID与证据不匹配")
    if support.claim == "site":
        if support.begin_time is not None or support.end_time is not None:
            raise ToolFailure("场地资料为获取时的背景快照，不能宣称历史时间窗覆盖")
        return identity["station_name"]
    if support.begin_time is None or support.end_time is None:
        raise ToolFailure("该判断必须说明时间窗")
    start, end = _business_time(support.begin_time), _business_time(support.end_time)
    if start >= end:
        raise ToolFailure("判断窗口必须正向")
    if support.claim == "weather":
        period = support.weather_period
        variable = support.weather_variable
        if period not in {"history", "forecast", "current"}:
            raise ToolFailure("须区分历史气象、当前观测和预报")
        if not variable or variable == "time":
            raise ToolFailure("气象支持关系须指定实际引用的观测字段")
        if period == "current":
            current = data.get("current") or {}
            if not current.get("time") or current.get(variable) is None:
                raise ToolFailure("没有可用的当前天气观测")
            moment = _business_time(current["time"])
            if not start <= moment <= end or end - start > timedelta(hours=1):
                raise ToolFailure("单次天气观测不能支持整段历史或日累计判断")
        else:
            daily = data.get(period, {}).get("daily", {})
            valid_days = set()
            values = daily.get(variable, [])
            for index, day in enumerate(daily.get("time", [])):
                if isinstance(values, list) and index < len(values) and isinstance(values[index], (int, float)):
                    valid_days.add(datetime.fromisoformat(day).date())
            day = start.date()
            while day <= (end - timedelta(microseconds=1)).date():
                if day not in valid_days:
                    raise ToolFailure("判断窗口存在未取得有效天气数据的日期")
                day += timedelta(days=1)
        return identity["station_name"]
    if support.claim == "data_quality":
        if start != _business_time(data["begin_time"]) or end != _business_time(data["end_time"]):
            raise ToolFailure("数据质量统计适用于完整查询窗口；不能给子窗口套用全窗数量，请按所需窗口重新查询")
        return identity["station_name"]
    if support.axis is None:
        raise ToolFailure("数值支持关系必须指定方向")
    feature = data.get("features", {}).get(support.axis, {})
    if support.scope == "common_period":
        feature = data.get("comparisons", {}).get("common_period", {}).get(support.axis, {}).get(str(support.station_uuid), {})
    elif support.scope in {"first_window", "second_window"}:
        key = "first" if support.scope == "first_window" else "second"
        feature = data.get("comparisons", {}).get(support.axis, {}).get(key, {})
    bounds = feature
    if feature.get("count", 0) < 2 or not feature.get("begin_time") or not feature.get("end_time"):
        raise ToolFailure("有效样本不足以支持变化判断")
    if support.claim == "jump" and feature.get("max_step_time") is None:
        raise ToolFailure("没有连续有效观测支持单步变化")
    if support.claim == "trend" and not feature.get("trend_supported", False):
        raise ToolFailure("没有有效趋势计算结果")
    if start < _business_time(bounds["begin_time"]) or end > _business_time(bounds["end_time"]):
        raise ToolFailure("判断时间窗超出实际证据覆盖")
    if support.claim in {"numeric_change", "trend"} and (start != _business_time(bounds["begin_time"]) or end != _business_time(bounds["end_time"])):
        raise ToolFailure("窗口净变化只支持计算窗口，请对所需子窗口重新计算")
    if support.claim == "jump" and not start <= _business_time(feature["max_step_time"]) <= end:
        raise ToolFailure("候选跳变时刻不在判断窗口内")
    return identity["station_name"]


class ReportFinding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    supports: list[EvidenceSupport] = Field(min_length=1, max_length=8)
    level: Literal["fact", "analysis", "inference"] = Field(
        description=(
            "fact 为观测事实；analysis 为由多个事实形成的判断；inference 为地质意义或诱因的专业推断，"
            "可以自然表达推测，不要求固定措辞或重复免责声明"
        )
    )
    text: str = Field(default="", max_length=300, description="分析或推断的解释；fact观测事实正文由服务端从supports生成，无需重填数值")
    station_uuids: list[UUID] = Field(default_factory=list, description="这条发现实际分析的测点UUID；每个对象均须有自身支持，背景对象不要列入")


class InvestigationReportInput(BaseModel):
    conclusion: str = Field(min_length=1, max_length=200, description="先回答哪些点需要看、为什么，一到两句")
    stations: list[ReportStation] = Field(min_length=1, max_length=100)
    findings: list[ReportFinding] = Field(min_length=1, max_length=30)
    next_steps: list[str] = Field(default_factory=list, max_length=6, description="建议进一步核查的内容")


def _current_turn_evidence(messages: list[BaseMessage]) -> list[ToolMessage]:
    evidence = []
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            break
        if isinstance(message, ToolMessage) and message.artifact is not None and message.name != REPORT_TOOL_NAME:
            evidence.append(message)
    return evidence


def _support_feature(support: EvidenceSupport, artifact: dict):
    data = artifact["data"]
    if support.scope == "common_period":
        return data.get("comparisons", {}).get("common_period", {}).get(support.axis, {}).get(str(support.station_uuid), {})
    if support.scope in {"first_window", "second_window"}:
        key = "first" if support.scope == "first_window" else "second"
        return data.get("comparisons", {}).get(support.axis, {}).get(key, {})
    return data.get("features", {}).get(support.axis, {})


def _covers_target_window(feature, start, end):
    if not feature.get('trend_supported'):
        return False
    span = (_business_time(feature['end_time']) - _business_time(feature['begin_time'])).total_seconds()
    target_span = (end - start).total_seconds()
    expected = target_span / (feature.get('cadence_hours', 1) * 3600) + 1
    return span >= target_span / 2 and feature['count'] / expected >= .5


def project_support(support: EvidenceSupport, artifact: dict):
    """数值由实际计算结果投影；模型只负责引用及解释。"""
    projected = support.model_dump(mode="json")
    data = artifact["data"]
    feature = _support_feature(support, artifact)
    if support.claim == "data_quality":
        projected["fact"] = data.get("quality", {})
    elif support.claim == "unavailable":
        projected["fact"] = {"limitation": data["message"]}
    elif support.claim == "weather":
        period = data.get(support.weather_period) or {}
        projected["fact"] = {
            "period": support.weather_period, "variable": support.weather_variable,
            "values": period.get("daily", period),
        }
    elif support.claim == "site":
        projected["fact"] = {"observed_at": data["observed_at"], "scope": "获取时场地背景快照"}
    elif feature:
        projected["fact"] = {key: feature.get(key) for key in (
            "count", "net_change_mm", "robust_slope_mm_day", "max_step_mm", "max_step_time",
            "cum_start_mm", "cum_end_mm", "baseline", "begin_time", "end_time", "cadence_hours",
            "effective_span_hours", "trend_supported", "units",
            "metric_name",
            "events", "event_count",
        )}
        projected["fact"]["sample_set"] = {key: value for key, value in feature.get("sample_set", {}).items() if key != "timestamps"}
    return projected


def fact_text(supports, evidence_by_id):
    """观测事实不再由模型复述数字；页面、导出和存证使用同一投影。"""
    statements = []
    scopes = {"window": "单站窗口", "common_period": "共同有效样本",
              "first_window": "前窗", "second_window": "后窗"}
    axes = {"n": "北向", "e": "东向", "u": "垂向", "h": "水平合成量H", "d": "三维合成量D"}
    for support in supports:
        artifact = evidence_by_id[support.evidence_id]
        name = _validate_support(support, artifact)
        fact = project_support(support, artifact).get("fact", {})
        prefix = f"{name}（{support.station_uuid}）"
        if support.claim in {"numeric_change", "trend", "jump"}:
            prefix += f" · {axes[support.axis]} · {scopes[support.scope]} · {fact['begin_time']} 至 {fact['end_time']}"
            details = [f"有效点 {fact['count']}"]
            for key, label, unit in (("net_change_mm", "净变化", "mm"),
                                     ("robust_slope_mm_day", "描述斜率", "mm/day"),
                                     ("cum_end_mm", "末点固定参考累计偏移", "mm")):
                value = fact.get(key)
                if value is not None:
                    details.append(f"{label} {value:.6g} {unit}")
            if support.claim == "jump":
                details.append(f"最大相邻变化 {fact['max_step_mm']:.6g} mm，时刻 {fact['max_step_time']}")
                for event in fact.get("events") or []:
                    details.append(f"候选 {event['time']}：{event['status']}；已观察保持至 {event['held_until']}，{event['held_hours']:.6g} 小时")
            if not fact.get("trend_supported"):
                details.append("样本或跨度不足以支持持续趋势")
        elif support.claim == "data_quality":
            prefix += f" · {fact.get('requested_begin', support.begin_time.isoformat())} 至 {fact.get('requested_end', support.end_time.isoformat())}"
            details = [f"请求日历预期 {fact.get('expected', '未知')} 点"]
            for axis, quality in fact.get("axes", {}).items():
                details.append(f"{axes[axis]}有效 {quality['valid']} 点，缺 {quality['missing']} 点")
        elif support.claim == "unavailable":
            details = [fact["limitation"].rstrip("。")]
        elif support.claim == "site":
            details = [f"场地背景快照，获取时刻 {fact['observed_at']}，不证明历史变化"]
        else:
            details = [f"气象资料类型 {support.weather_period}，字段 {support.weather_variable}，范围 {support.begin_time.isoformat()} 至 {support.end_time.isoformat()}；数值见对应气象证据"]
        statements.append(prefix + "：" + "；".join(details))
    return "。".join(dict.fromkeys(statements)) + "。"


def _validate_report(report: InvestigationReportInput, evidence: list[ToolMessage]) -> dict[str, str]:
    evidence_by_id = {evidence_id(message.tool_call_id): message.artifact for message in evidence}
    tool_call_ids = {evidence_id(message.tool_call_id): message.tool_call_id for message in evidence}
    declared = {str(station.station_uuid) for station in report.stations}
    if len(declared) != len(report.stations):
        raise ToolFailure("简报测点UUID不能重复；同名站分别使用各自UUID")

    def validate(support):
        artifact = evidence_by_id.get(support.evidence_id)
        if artifact is None:
            raise ToolFailure(f"依据编号 {support.evidence_id} 不在本轮查询结果中，只能引用本轮 lma_evidence 编号。")
        if str(support.station_uuid) not in declared:
            raise ToolFailure("支持关系中的测点必须列入报告")
        return _validate_support(support, artifact), artifact

    for station in report.stations:
        start, end = _business_time(station.begin_time), _business_time(station.end_time)
        if start >= end:
            raise ToolFailure("单站结论目标窗口必须正向")
        observed = False
        stable_window_covered = False
        trend_scopes = {}
        for support in station.supports:
            if support.station_uuid != station.station_uuid:
                raise ToolFailure("单站结论必须引用该站UUID的证据，不能用其他测点代替")
            name, artifact = validate(support)
            if name != station.station_name:
                raise ToolFailure("测点名称须使用该UUID的证据展示名称")
            if support.begin_time is not None and (not start <= _business_time(support.begin_time) < _business_time(support.end_time) <= end):
                raise ToolFailure("单站支持窗口必须包含于目标窗口")
            feature = _support_feature(support, artifact)
            if artifact.get("kind") == "numerical" and artifact.get("status") != "error":
                if station.status == '未见明显变化' and (_business_time(artifact['data']['begin_time']) > start or _business_time(artifact['data']['end_time']) < end):
                    raise ToolFailure("单站结论的数值查询须覆盖目标窗口；短窗不能冒充整个长期调查")
                if support.claim in {"numeric_change", "trend", "jump"}:
                    observed = observed or feature.get("trend_supported", False) or (support.claim == "jump" and feature.get("event_count", 0) > 0)
                if station.status == '未见明显变化' and support.claim in {'numeric_change', 'trend'}:
                    if not _covers_target_window(feature, start, end):
                        raise ToolFailure("有效跨度或覆盖不足，不能把局部短窗表述为目标窗口未见变化")
                if (station.status == '未见明显变化' and support.scope == 'window'
                        and artifact['data']['station_uuid'] == str(station.station_uuid)):
                    stable_window_covered = stable_window_covered or all(
                        _covers_target_window(artifact['data'].get('features', {}).get(axis, {}), start, end)
                        for axis in ('n', 'e', 'u')
                    )
                if support.claim == "trend":
                    key = (support.evidence_id, support.axis)
                    trend_scopes.setdefault(key, set()).add(support.scope)
        if station.status not in {"数据不足", "暂无法分析"} and not observed:
            raise ToolFailure("该站缺少适用且充分的观测事实；台账、失败或两点斜率不能支持已调查稳定结论，可如实交付数据不足")
        if station.status == '未见明显变化' and not stable_window_covered:
            raise ToolFailure("整站未见明显变化须有N/E/U三方向的单站目标窗充分观测；方向缺失时如实交付数据不足，单方向结果仍可自由解释")
        has_comparable_trends = any(
            {"first_window", "second_window"} <= scopes
            for scopes in trend_scopes.values()
        )
        if station.acceleration not in (None, "无法判断") and not has_comparable_trends:
            raise ToolFailure("加速判断须有该站两个适用窗口的充分趋势证据，不能仅凭单窗或两点斜率")

    for finding in report.findings:
        if finding.level != "fact" and not finding.text.strip():
            raise ToolFailure("分析和推断须说明解释；观测事实正文由服务端生成")
        supported = set()
        for support in finding.supports:
            validate(support)
            supported.add(str(support.station_uuid))
        if not {str(identifier) for identifier in finding.station_uuids}.issubset(supported):
            raise ToolFailure("发现列出的每个测点都必须有自身适用事实，不能跨站借用支持")
    return tool_call_ids


@tool(REPORT_TOOL_NAME, args_schema=InvestigationReportInput, response_format="content_and_artifact")
async def submit_investigation_report(
    conclusion: str,
    stations: list[ReportStation],
    findings: list[ReportFinding],
    runtime: ToolRuntime,
    next_steps: list[str] | None = None,
) -> tuple[str, dict]:
    """提交本轮调查简报并结束回答。

    数据分析需要结构化简报时自主选择调用；简短分析、追问或其他问题可以直接回答。提交成功后不再输出其他内容，
    简报即最终回答；校验失败时根据错误信息修正后重新提交。
    """
    report = InvestigationReportInput(
        conclusion=conclusion, stations=stations, findings=findings, next_steps=next_steps or [],
    )
    evidence = _current_turn_evidence(runtime.state["messages"])
    tool_call_ids = _validate_report(report, evidence)
    evidence_by_id = {evidence_id(message.tool_call_id): message.artifact for message in evidence}

    display = {
        "conclusion": report.conclusion,
        "stations": [{**station.model_dump(mode="json"),
                      "supports": [project_support(support, evidence_by_id[support.evidence_id]) for support in station.supports]}
                     for station in report.stations],
        "findings": [
            {
                "supports": [project_support(support, evidence_by_id[support.evidence_id]) for support in finding.supports],
                "level": finding.level,
                "text": fact_text(finding.supports, evidence_by_id) if finding.level == "fact" else finding.text,
                "station_uuids": [str(identifier) for identifier in finding.station_uuids] or list(dict.fromkeys(str(support.station_uuid) for support in finding.supports)),
                "evidence": list(dict.fromkeys(tool_call_ids[support.evidence_id] for support in finding.supports)),
            }
            for finding in report.findings
        ],
        "next_steps": report.next_steps,
    }
    return tool_result(display, kind="investigation_report", display=display)


def report_in_last_turn(messages: list[BaseMessage]) -> tuple[str, dict] | None:
    """返回本轮成功提交的简报（tool_call_id, 展示数据）。"""
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            return None
        if is_evidence(message) and message.name == REPORT_TOOL_NAME:
            return message.tool_call_id, message.artifact["data"]
    return None
