"""首页“当前判断”：较新的调查结论优先，调查后巡检发现新变化时回到初筛。"""

import unittest
from datetime import datetime

from app.station_judgment import current_judgment, judgment_sort_key

INSPECTED = datetime(2026, 11, 14, 8, 0)
EARLIER = datetime(2026, 11, 13, 8, 0)
LATER = datetime(2026, 11, 14, 10, 0)


def conclusion(status, at):
    return {"status": status, "reason": "调查原因", "created_at": at, "session_id": "s1"}


class CurrentJudgmentTests(unittest.TestCase):
    def test_newer_investigation_overrides_optimistic_screening(self):
        """初筛漏掉、调查已判明的问题点不能在首页以“平稳”出现（审查实测 ST02）。"""
        judgment = current_judgment("未见明显变化", [], INSPECTED, conclusion("需人工复核", LATER))
        self.assertEqual(judgment["status"], "需人工复核")
        self.assertEqual(judgment["source"], "调查")
        self.assertEqual(judgment["group"], "需要处理")

    def test_new_change_after_investigation_returns_to_screening(self):
        judgment = current_judgment("建议调查", ["近 7 天明显变快"], INSPECTED, conclusion("持续关注", EARLIER))
        self.assertEqual(judgment["status"], "建议调查")
        self.assertTrue(judgment["changed_since_investigation"])
        self.assertEqual(judgment["reason"], "近 7 天明显变快")

    def test_quiet_inspection_after_investigation_keeps_the_investigation(self):
        judgment = current_judgment("未见明显变化", [], INSPECTED, conclusion("持续关注", EARLIER))
        self.assertEqual(judgment["status"], "持续关注")
        self.assertEqual(judgment["group"], "持续关注")

    def test_inspection_only_and_nothing(self):
        self.assertEqual(current_judgment("数据不足", ["缺测"], INSPECTED, None)["group"], "数据问题")
        self.assertIsNone(current_judgment(None, None, None, None))

    def test_sorting_puts_review_before_screening_flag_before_stable(self):
        rows = [
            ("平稳点", current_judgment("未见明显变化", [], INSPECTED, None)),
            ("建议点", current_judgment("建议调查", ["x"], INSPECTED, None)),
            ("复核点", current_judgment("未见明显变化", [], INSPECTED, conclusion("需人工复核", LATER))),
        ]
        ordered = sorted(rows, key=lambda row: judgment_sort_key(row[1], row[0]))
        self.assertEqual([name for name, _ in ordered], ["复核点", "建议点", "平稳点"])
