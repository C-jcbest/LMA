"""调查完成范围与结论证据边界，不依赖外部服务。"""
import unittest
from copy import deepcopy

from pydantic import ValidationError

from app.agent.report import EvidenceSupport, _validate_support
from app.agent.tool_protocol import ToolFailure
from app.server.investigation_models import InvestigationProgress


STATION = "11111111-1111-1111-1111-111111111111"


class InvestigationContractTests(unittest.TestCase):
    def progress(self):
        return {
            "goal": "复核趋势",
            "targets": [{
                "target_id": "north-trend", "station_uuid": STATION,
                "question": "北向趋势", "begin_time": "2026-11-01T00:00:00",
                "end_time": "2026-11-08T00:00:00",
            }],
        }

    def test_uncovered_target_cannot_be_completed(self):
        with self.assertRaises(ValidationError):
            InvestigationProgress.model_validate({**self.progress(), "status": "completed"})

    def test_coverage_requires_known_target_and_evidence(self):
        for covered in (["unknown"], ["north-trend"]):
            with self.subTest(covered=covered), self.assertRaises(ValidationError):
                InvestigationProgress.model_validate({**self.progress(), "covered": covered})

    def support(self, **overrides):
        return EvidenceSupport(
            **{"evidence_id": "E1", "station_uuid": STATION, "axis": "n",
               "begin_time": "2026-11-02T00:00:00", "end_time": "2026-11-03T00:00:00",
               "claim": "numeric_change", "rationale": "北向窗口净变化", **overrides}
        )

    def numerical(self):
        return {"kind": "numerical", "data": {
            "station_uuid": STATION, "station_name": "测点A",
            "begin_time": "2026-11-01 00:00:00", "end_time": "2026-11-08 00:00:00",
            "features": {"n": {"count": 2, "begin_time": "2026-11-02 00:00:00",
                                  "end_time": "2026-11-03 00:00:00"}},
        }}

    def test_requested_window_does_not_prove_actual_coverage(self):
        with self.assertRaises(ToolFailure):
            _validate_support(self.support(begin_time="2026-11-01T00:00:00"), self.numerical())
        self.assertEqual(_validate_support(self.support(), self.numerical()), "测点A")

    def test_timezone_equivalent_window_is_accepted(self):
        self.assertEqual(_validate_support(self.support(
            begin_time="2026-11-01T16:00:00Z", end_time="2026-11-02T16:00:00Z"), self.numerical()), "测点A")

    def test_common_period_support_resolves_comparison_station(self):
        other = "22222222-2222-2222-2222-222222222222"
        artifact = self.numerical()
        artifact['data']['comparisons'] = {
            'station_names': {other: '测点B'},
            'common_period': {'n': {other: artifact['data']['features']['n']}},
        }
        self.assertEqual(_validate_support(self.support(station_uuid=other, scope='common_period'), artifact), '测点B')
        with self.assertRaises(ToolFailure):
            _validate_support(self.support(station_uuid=other), artifact)

    def test_other_axis_or_missing_step_cannot_support_claim(self):
        for support in (self.support(axis="u"), self.support(claim="jump")):
            with self.subTest(support=support), self.assertRaises(ToolFailure):
                _validate_support(support, self.numerical())

    def test_raw_gnss_supports_quality_but_not_numeric_trend(self):
        artifact = self.numerical()
        artifact['kind'] = 'gnss_series'
        full_window = self.support(claim='data_quality', axis=None, begin_time='2026-11-01T00:00:00', end_time='2026-11-08T00:00:00')
        self.assertEqual(_validate_support(full_window, artifact), '测点A')
        with self.assertRaises(ToolFailure):
            _validate_support(self.support(claim='data_quality', axis=None), artifact)
        with self.assertRaises(ToolFailure):
            _validate_support(self.support(claim='trend'), artifact)
        with self.assertRaises(ToolFailure):
            _validate_support(self.support(claim='data_quality', end_time='2026-12-01T00:00:00'), artifact)

    def test_weather_period_and_missing_days_are_checked(self):
        weather = {"kind": "weather", "data": {
            "location": {"station_uuid": STATION, "station_name": "测点A"},
            "history": {"daily": {"time": ["2026-11-02"], "precipitation_sum": [0]}},
        }}
        support = self.support(claim="weather", weather_period="history", weather_variable="precipitation_sum")
        self.assertEqual(_validate_support(support, weather), "测点A")
        missing = deepcopy(weather)
        missing["data"]["history"]["daily"]["precipitation_sum"] = [None]
        with self.assertRaises(ToolFailure):
            _validate_support(support, missing)
        with self.assertRaises(ToolFailure):
            _validate_support(self.support(claim="weather", weather_period="forecast", weather_variable="precipitation_sum"), weather)

    def test_site_snapshot_does_not_claim_historical_coverage(self):
        artifact = {"kind": "site_environment", "data": {
            "center_station": {"station_uuid": STATION, "station_name": "测点A"},
        }}
        with self.assertRaises(ToolFailure):
            _validate_support(self.support(claim="site"), artifact)
        self.assertEqual(_validate_support(self.support(claim="site", begin_time=None, end_time=None), artifact), "测点A")
