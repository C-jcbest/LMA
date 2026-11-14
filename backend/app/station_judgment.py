"""测点的“当前判断”：在最近一次巡检初筛和最新调查结论之间取一个，供首页、测点页和智能体共用。

初筛是程序粗筛，调查结论是看过数据后的判断。首页要回答“目前哪些点需要我处理”，
所以较新的调查结论优先；只有调查之后的巡检又发现了新变化，才回到初筛结果并提示有新变化。
"""

from datetime import datetime
from typing import Literal

JudgmentGroup = Literal["需要处理", "持续关注", "数据问题", "平稳"]

_GROUP_BY_STATUS: dict[str, JudgmentGroup] = {
    "需人工复核": "需要处理",
    "建议调查": "需要处理",
    "持续关注": "持续关注",
    "数据不足": "数据问题",
    "暂无法分析": "数据问题",
    "未见明显变化": "平稳",
}
# 首页分组的先后，也是“需要处理”组内的排序依据。
GROUP_ORDER: tuple[JudgmentGroup, ...] = ("需要处理", "持续关注", "数据问题", "平稳")
_STATUS_ORDER = ("需人工复核", "建议调查", "持续关注", "数据不足", "暂无法分析", "未见明显变化")
_NEW_CHANGE_SCREENING = "建议调查"
_REASON_LIMIT = 2


def current_judgment(
    screening: str | None,
    screening_reasons: list[str] | None,
    inspected_at: datetime | None,
    conclusion: dict | None,
) -> dict | None:
    """conclusion 为最新登记结论（status、reason、created_at、session_id）；都没有时返回 None。"""
    inspection_reason = "；".join((screening_reasons or [])[:_REASON_LIMIT])
    investigated_at = conclusion.get("created_at") if conclusion else None
    investigation_is_newer = conclusion is not None and (
        inspected_at is None or investigated_at is None or investigated_at >= inspected_at
    )
    if conclusion is not None and (investigation_is_newer or screening != _NEW_CHANGE_SCREENING):
        return _judgment(conclusion["status"], "调查", investigated_at, conclusion["reason"],
                         changed_since_investigation=False, session_id=conclusion.get("session_id"))
    if screening is None:
        return None
    return _judgment(screening, "巡检", inspected_at, inspection_reason,
                     changed_since_investigation=conclusion is not None, session_id=None)


def _judgment(status, source, at, reason, *, changed_since_investigation, session_id) -> dict:
    return {
        "status": status,
        "source": source,
        "at": at,
        "reason": reason,
        "group": _GROUP_BY_STATUS.get(status, "数据问题"),
        "changed_since_investigation": changed_since_investigation,
        "session_id": session_id,
    }


def judgment_sort_key(judgment: dict | None, station_name: str) -> tuple:
    if judgment is None:
        return (len(GROUP_ORDER), len(_STATUS_ORDER), station_name)
    status = judgment["status"]
    status_rank = _STATUS_ORDER.index(status) if status in _STATUS_ORDER else len(_STATUS_ORDER)
    return (GROUP_ORDER.index(judgment["group"]), status_rank, station_name)
