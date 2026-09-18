import base64
import json
import unittest
from datetime import datetime
from types import SimpleNamespace

from app.agent.vision import VisionObservations, _render_all_charts, _validate_observations


class VisionRenderingTests(unittest.TestCase):
    def test_all_three_chart_artifacts_are_valid_png_images(self):
        points = [
            SimpleNamespace(data_time="2026-09-01 00:00:00", n="1.000", e="2.000", u="3.000"),
            SimpleNamespace(data_time="2026-09-01 01:00:00", n="1.001", e="2.002", u="3.003"),
            SimpleNamespace(data_time="2026-09-01 02:00:00", n="1.002", e="2.004", u="3.006"),
        ]
        charts = _render_all_charts(
            points,
            (1.0, 2.0, 3.0),
            "TEST-STATION",
            "2026-09-01 00:00:00",
            "2026-09-01 02:00:00",
        )
        self.assertEqual(
            {chart["name"] for chart in charts},
            {"raw_coordinates", "cumulative_displacement", "resultant_displacement"},
        )
        for chart in charts:
            self.assertTrue(base64.b64decode(chart["png_base64"]).startswith(b"\x89PNG\r\n\x1a\n"))

    def test_visual_json_is_validated_and_out_of_window_candidates_are_removed(self):
        payload = {
            "trends": ["北向缓慢变化"],
            "candidates": [
                {
                    "metric": "N",
                    "start_at": "2026-09-01 01:00:00",
                    "end_at": "2026-09-01 02:00:00",
                    "description": "窗口内候选",
                },
                {
                    "metric": "E",
                    "start_at": "2026-08-01 01:00:00",
                    "end_at": "2026-08-01 02:00:00",
                    "description": "窗口外候选",
                },
            ],
        }
        result = _validate_observations(
            payload,
            datetime(2026, 9, 1, 0, 0),
            datetime(2026, 9, 2, 0, 0),
        )
        self.assertIsInstance(result, VisionObservations)
        self.assertEqual([candidate.description for candidate in result.candidates], ["窗口内候选"])



if __name__ == "__main__":
    unittest.main()
