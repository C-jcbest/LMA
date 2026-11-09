"""调查简报：把事实、分析、推断分层从提示词约定变成服务端校验的数据结构。"""

import re
from typing import Literal

from langchain.tools import ToolRuntime, tool
from langchain_core.messages import BaseMessage, HumanMessage, ToolMessage
from pydantic import BaseModel, Field

from app.agent.message_context import evidence_id, is_evidence
from app.agent.tool_protocol import ToolFailure, tool_result

REPORT_TOOL_NAME = "submit_investigation_report"

# PRD 第 3、12 节：推断必须使用审慎表达，且不得越过系统的证据能力。
_HEDGING_PATTERN = re.compile(r"可能|疑似|不排除|需要进一步核查|需进一步核查|证据不足|尚不能确认|无法确认")
_FORBIDDEN_PATTERN = re.compile(r"已(经)?发生滑坡|即将发生滑坡|必须立即撤离")


class ReportStation(BaseModel):
    station_name: str = Field(min_length=1, max_length=80, description="测点名称，使用工具结果中的原始名称")
    status: Literal["未见明显变化", "持续关注", "需人工复核", "数据不足", "暂无法分析"]
    reason: str = Field(min_length=1, max_length=200, description="得到该调查状态的一句话原因")
    acceleration: Literal["未见持续加速", "疑似加速", "无法判断"]
    data_quality: str = Field(min_length=1, max_length=120, description="数据是否可靠的一句话说明，含缺测情况")


class ReportFinding(BaseModel):
    level: Literal["fact", "analysis", "inference"] = Field(
        description=(
            "fact 为观测事实；analysis 为由多个事实形成的判断；inference 为地质意义或诱因的专业推断，"
            "正文必须含“可能”“疑似”“不排除”“需要进一步核查”之一"
        )
    )
    text: str = Field(min_length=1, max_length=300)
    evidence_ids: list[str] = Field(
        default_factory=list, max_length=8,
        description="支撑这条发现的依据编号，来自本轮工具结果末尾的 lma_evidence 标记",
    )


class InvestigationReportInput(BaseModel):
    conclusion: str = Field(min_length=1, max_length=200, description="先回答哪些点需要看、为什么，一到两句")
    stations: list[ReportStation] = Field(min_length=1, max_length=100)
    findings: list[ReportFinding] = Field(min_length=1, max_length=30)
    next_steps: list[str] = Field(default_factory=list, max_length=6, description="建议进一步核查的内容")


def _names_in_artifact(artifact: dict) -> set[str]:
    data = artifact.get("data", {})
    match artifact.get("kind"):
        case "gnss_series" | "vision":
            return {data["station_name"]}
        case "weather":
            name = data["location"].get("station_name")
            return {name} if name else set()
        case "site_environment":
            return {data["center_station"]["station_name"],
                    *(station["station_name"] for station in data["group_stations"])}
        case "station_list":
            return {station["station_name"] for station in data.get("stations") or []}
    return set()


def _current_turn_evidence(messages: list[BaseMessage]) -> list[ToolMessage]:
    evidence = []
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            break
        if is_evidence(message) and message.name != REPORT_TOOL_NAME:
            evidence.append(message)
    return evidence


def _validate_report(report: InvestigationReportInput, evidence: list[ToolMessage]) -> dict[str, str]:
    """失败信息返回给模型修正，因此明确指出问题所在。"""
    tool_call_ids = {evidence_id(message.tool_call_id): message.tool_call_id for message in evidence}
    known_stations = set().union(*(_names_in_artifact(message.artifact) for message in evidence), set())

    for station in report.stations:
        if station.station_name not in known_stations:
            raise ToolFailure(f"简报中的测点“{station.station_name}”不在本轮查询结果中，请使用工具返回的测点名称。")

    written_text = [report.conclusion, *(finding.text for finding in report.findings), *report.next_steps]
    if any(_FORBIDDEN_PATTERN.search(text) for text in written_text):
        raise ToolFailure("简报包含超出系统证据能力的表述，请改为审慎的调查描述。")

    for finding in report.findings:
        unknown = [item for item in finding.evidence_ids if item not in tool_call_ids]
        if unknown:
            raise ToolFailure(f"依据编号 {'、'.join(unknown)} 不存在，只能引用本轮工具结果中的 lma_evidence 编号。")
        if finding.level in {"fact", "analysis"} and not finding.evidence_ids:
            raise ToolFailure(f"观测事实和分析判断必须引用依据编号：{finding.text}")
        if finding.level == "inference" and not _HEDGING_PATTERN.search(finding.text):
            raise ToolFailure(f"专业推断必须使用“可能”“疑似”“需要进一步核查”等审慎表达：{finding.text}")
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

    完成对监测点状态、异常、趋势或诱因的调查后调用。提交成功后不再输出其他内容，
    简报即最终回答；校验失败时根据错误信息修正后重新提交。
    """
    report = InvestigationReportInput(
        conclusion=conclusion, stations=stations, findings=findings, next_steps=next_steps or [],
    )
    tool_call_ids = _validate_report(report, _current_turn_evidence(runtime.state["messages"]))

    facts = report.model_dump(mode="json")
    display = {
        "conclusion": report.conclusion,
        "stations": [station.model_dump(mode="json") for station in report.stations],
        "findings": [
            {
                "level": finding.level,
                "text": finding.text,
                "evidence": [tool_call_ids[item] for item in finding.evidence_ids],
            }
            for finding in report.findings
        ],
        "next_steps": report.next_steps,
    }
    return tool_result(facts, kind="investigation_report", display=display)


def report_in_last_turn(messages: list[BaseMessage]) -> tuple[str, dict] | None:
    """返回本轮成功提交的简报（tool_call_id, 展示数据）。"""
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            return None
        if is_evidence(message) and message.name == REPORT_TOOL_NAME:
            return message.tool_call_id, message.artifact["data"]
    return None
