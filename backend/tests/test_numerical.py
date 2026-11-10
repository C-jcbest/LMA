"""数值证据的业务边界回归。"""
import unittest
from datetime import timedelta
from app.agent.numerical import axis_features, compare_windows, common_period_features
from app.agent.tools import _detect_gaps
from test_inspection_screening import NOW, point

class NumericalTests(unittest.TestCase):
    def test_daily_calendar_missing_points_do_not_invent_continuous_outage_duration(self):
        from app.observations import normalize_observations, observation_quality
        start = NOW.replace(hour=0)
        end = start + timedelta(days=1)
        samples = [point(start + timedelta(hours=1), 100)]
        points, _ = normalize_observations(samples)
        quality = observation_quality(points, start.strftime('%Y-%m-%d %H:%M:%S'),
                                      end.strftime('%Y-%m-%d %H:%M:%S'), sample_times=['00:00', '01:00'])
        self.assertEqual(quality['expected'], 3)
        self.assertEqual(quality['missing'], 2)
        self.assertEqual([gap['missing_count'] for gap in quality['gaps']], [1, 1])
        self.assertTrue(all(gap['missing_hours'] is None for gap in quality['gaps']))

    def test_calendar_quality_catches_regular_and_boundary_missing_values(self):
        from app.observations import normalize_observations, observation_quality
        start = NOW.replace(hour=0)
        points = [point(start + timedelta(hours=hour), 100) for hour in (2, 4, 6, 8, 10)]
        normalized, cleaning = normalize_observations(list(reversed(points)), start.strftime('%Y-%m-%d %H:%M:%S'), (start + timedelta(hours=12)).strftime('%Y-%m-%d %H:%M:%S'))
        quality = observation_quality(normalized, start.strftime('%Y-%m-%d %H:%M:%S'), (start + timedelta(hours=12)).strftime('%Y-%m-%d %H:%M:%S'), cleaning=cleaning)
        self.assertEqual(quality['expected'], 13)
        self.assertEqual(quality['missing'], 8)
        self.assertEqual(quality['gaps'][0]['boundary'], 'leading')
        self.assertEqual(quality['gaps'][-1]['boundary'], 'trailing')
        self.assertEqual(quality['axes']['n']['valid'], 5)

    def test_normalized_raw_and_numerical_paths_agree_on_nonfinite_and_duplicates(self):
        from app.observations import normalize_observations
        from app.agent.tools import _axis_summary
        points = [point(NOW + timedelta(hours=hour), value) for hour, value in ((2, 100.002), (0, 100), (1, 'nan'), (3, 100.003), (3, 99))]
        normalized, cleaning = normalize_observations(points)
        summary = _axis_summary([item.n for item in normalized])
        feature = axis_features([item.data_time for item in normalized], [item.n for item in normalized])
        self.assertEqual(summary['count'], feature['count'])
        self.assertAlmostEqual(summary['change'] * 1000, feature['net_change_mm'])
        self.assertAlmostEqual(feature['net_change_mm'], 2)
        self.assertEqual(cleaning['duplicate_timestamps'], 1)
        self.assertEqual(cleaning['invalid_values']['n'], 1)

    def test_observed_step_persistence_survives_later_unknown_interval(self):
        times = [(NOW + timedelta(days=day)).strftime('%Y-%m-%d %H:%M:%S') for day in range(26)]
        values = [100 if day < 5 else 100.01 for day in range(26)]
        original = axis_features(times, values, cadence_hours=24)
        extended = axis_features([*times, (NOW + timedelta(days=28)).strftime('%Y-%m-%d %H:%M:%S')], [*values, 100.01], cadence_hours=24)
        self.assertEqual(original['jump_persistence'], '持续')
        self.assertEqual(extended['jump_persistence'], '持续')
        self.assertEqual(extended['events'][0]['held_until'], times[-1])
        self.assertEqual(extended['events'][0]['held_hours'], 20 * 24)
        self.assertEqual(len(extended['events'][0]['later_unknown_intervals']), 1)

    def test_multiple_steps_are_separate_from_smooth_drift(self):
        times = [(NOW + timedelta(hours=hour)).strftime('%Y-%m-%d %H:%M:%S') for hour in range(40)]
        values = [100 + (0 if hour < 8 else .01) - (0 if hour < 24 else .006) for hour in range(40)]
        features = axis_features(times, values)
        self.assertEqual(features['event_count'], 2)
        self.assertGreater(features['events'][0]['step_mm'], 0)
        self.assertLess(features['events'][1]['step_mm'], 0)
        self.assertFalse(axis_features(times[:2], values[:2])['trend_supported'])

    def test_common_sample_sets_are_axis_specific(self):
        stations = {
            'A': [point(NOW + timedelta(hours=hour), 100 + hour * .001, up='' if hour == 1 else 300) for hour in range(3)],
            'B': [point(NOW + timedelta(hours=hour), 100, up=300) for hour in (1, 2)],
        }
        self.assertEqual(common_period_features(stations, 'n')['A']['count'], 2)
        self.assertEqual(common_period_features(stations, 'u')['A']['count'], 1)

    def test_fixed_reference_and_resultant_have_distinct_window_changes(self):
        from app.agent.numerical import window_features
        from types import SimpleNamespace
        station = SimpleNamespace(station_uuid='A', station_n0=100, station_e0=200, station_u0=300)
        points = [point(NOW + timedelta(hours=hour), 100 + .003 * (hour + 1), 200 + .004 * (hour + 1), 300) for hour in range(2)]
        features = window_features(points, station, points[0].data_time, points[-1].data_time)
        self.assertAlmostEqual(features['h']['cum_end_mm'], 10)
        self.assertAlmostEqual(features['h']['net_change_mm'], 5)
        self.assertAlmostEqual(features['n']['cum_end_mm'], 6)
        self.assertAlmostEqual(features['n']['net_change_mm'], 3)
        station.station_n0 = None
        missing = window_features(points, station, points[0].data_time, points[-1].data_time)
        self.assertIsNone(missing['n']['cum_end_mm'])
        self.assertAlmostEqual(missing['n']['net_change_mm'], 3)
        self.assertEqual(missing['h']['count'], 0)

    def test_missing_hours_excludes_observed_boundary_interval(self):
        for hours, expected in (((0, 1, 2, 6, 7, 8), 3), ((0, 1, 3, 4, 5), 1)):
            with self.subTest(hours=hours):
                points = [point(NOW + timedelta(hours=hour), 100) for hour in hours]
                gaps = _detect_gaps(list(reversed(points)), points[0].data_time, points[-1].data_time)
                self.assertEqual(len(gaps), 1)
                self.assertEqual(gaps[0]['missing_hours'], expected)

    def test_continuing_change_and_terminal_jump_are_not_return_to_baseline(self):
        times = [(NOW + timedelta(hours=i)).strftime('%Y-%m-%d %H:%M:%S') for i in range(25)]
        rising = [100 + i * .001 for i in range(25)]
        self.assertEqual(axis_features(times, rising)['events'], [])
        self.assertTrue(axis_features(times, rising)['trend_supported'])
        self.assertGreater(axis_features(times, rising)['net_change_mm'], 0)
        terminal = [100.0] * 24 + [100.1]
        self.assertEqual(axis_features(times, terminal)['jump_persistence'], '待观察')

    def test_isolated_spike_is_not_persistent_step(self):
        times = [(NOW + timedelta(hours=i)).strftime('%Y-%m-%d %H:%M:%S') for i in range(25)]
        values = [100.0] * 25
        values[10] = 100.1
        self.assertEqual(axis_features(times, values)['events'][0]['status'], '回落')
        self.assertIsNone(axis_features(times, [100.0] * 25)['max_step_time'])

    def test_unknown_is_not_zero(self):
        result = axis_features([], [])
        self.assertIsNone(result['net_change_mm'])
        self.assertIsNone(result['max_step_mm'])

    def test_duplicate_and_gap_do_not_prove_jump(self):
        times = [(NOW + timedelta(hours=i)).strftime('%Y-%m-%d %H:%M:%S') for i in (0, 0, 10, 20)]
        result = axis_features(times, [0, 10, 20, 30])
        self.assertEqual(result['count'], 2)
        self.assertIsNone(result['max_step_mm'])
        self.assertEqual(result['jump_persistence'], '样本不足')

    def test_trend_units_and_velocity_comparison(self):
        times = [(NOW + timedelta(days=i)).strftime('%Y-%m-%d %H:%M:%S') for i in range(10)]
        first = axis_features(times, [100+i*.001 for i in range(10)], cadence_hours=24)
        second = axis_features(times, [100+i*.002 for i in range(10)], cadence_hours=24)
        self.assertAlmostEqual(first['net_change_mm'], 9)
        comparison = compare_windows(first, second)
        self.assertAlmostEqual(comparison['velocity_difference_mm_day'], 1)
        self.assertAlmostEqual(comparison['speed_ratio'], 2)

    def test_common_period_excludes_nonoverlap_and_missing(self):
        stations = {
            'a': [point(NOW+timedelta(hours=i),100+i*.001) for i in range(5)],
            'b': [point(NOW+timedelta(hours=i),200+i*.002) for i in range(3,8)],
        }
        result = common_period_features(stations, 'n')
        self.assertEqual(result['a']['count'], 2)
        self.assertAlmostEqual(result['a']['net_change_mm'], 1)
        self.assertAlmostEqual(result['b']['net_change_mm'], 2)
from unittest.mock import AsyncMock, patch
from app.agent.numerical_tool import analyze_gnss_numerically
from app.beidou.schemas import Station

class NumericalToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_daily_long_history_and_compact_model_context(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get_daily_data.return_value = [point(NOW-timedelta(days=i),100-i*.001) for i in range(90)]
        station = Station(station_uuid='11111111-1111-1111-1111-111111111111', station_name='测试点', station_type=3, group_uuid='g', group_name='测试组')
        with patch('app.agent.numerical_tool._build_client', return_value=client), patch('app.agent.numerical_tool._resolve_station', return_value=station):
            result = await analyze_gnss_numerically.ainvoke({
                'type':'tool_call', 'id':'long-history', 'name':'analyze_gnss_numerically',
                'args':{'station_name_or_uuid':station.station_uuid, 'sampling':'daily',
                        'begin_time':(NOW-timedelta(days=90)).strftime('%Y-%m-%d %H:%M:%S'),
                        'end_time':NOW.strftime('%Y-%m-%d %H:%M:%S')},
            })
        import json
        self.assertNotIn('points', json.loads(result.content))
        self.assertEqual(len(result.artifact['data']['points']), 90)
        self.assertEqual(result.artifact['data']['sampling'], 'daily')
        self.assertAlmostEqual(result.artifact['data']['features']['n']['robust_slope_mm_day'], 1)
        self.assertEqual(client.get_daily_data.await_args.kwargs['sample_times'], ['15:00'])

    async def test_tool_returns_reviewable_snapshot_without_visual_model(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get_daily_data.return_value = [point(NOW-timedelta(hours=i),100-i*.001) for i in range(10)]
        station = Station(station_uuid='11111111-1111-1111-1111-111111111111', station_name='测试点', station_type=3, group_uuid='group', group_name='测试组')
        with patch('app.agent.numerical_tool._build_client', return_value=client), patch('app.agent.numerical_tool._resolve_station', return_value=station):
            result = await analyze_gnss_numerically.ainvoke({
                'type': 'tool_call', 'id': 'numeric-1', 'name': 'analyze_gnss_numerically',
                'args': {'station_name_or_uuid':'测试点', 'begin_time':(NOW-timedelta(days=1)).strftime('%Y-%m-%d %H:%M:%S'), 'end_time':NOW.strftime('%Y-%m-%d %H:%M:%S')},
            })
        self.assertEqual(result.artifact['kind'], 'numerical')
        self.assertEqual(len(result.artifact['data']['points']), 10)
        self.assertAlmostEqual(result.artifact['data']['features']['n']['net_change_mm'], 9)
        self.assertIn('observedAt', result.artifact)

    async def test_same_group_comparison_uses_common_timestamps(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        first = Station(station_uuid='11111111-1111-1111-1111-111111111111', station_name='A', station_type=3, group_uuid='g', group_name='G')
        second = Station(station_uuid='22222222-2222-2222-2222-222222222222', station_name='B', station_type=3, group_uuid='g', group_name='G')
        client.get_daily_data.side_effect = [
            [point(NOW-timedelta(hours=i),100-i*.001) for i in range(10)],
            [point(NOW-timedelta(hours=i),200-i*.002) for i in range(5)],
        ]
        with patch('app.agent.numerical_tool._build_client', return_value=client), patch('app.agent.numerical_tool._resolve_station', side_effect=[first,second]):
            result = await analyze_gnss_numerically.ainvoke({'type':'tool_call','id':'compare','name':'analyze_gnss_numerically','args':{
                'station_name_or_uuid':first.station_uuid, 'compare_station_uuids':[second.station_uuid],
                'begin_time':(NOW-timedelta(days=1)).strftime('%Y-%m-%d %H:%M:%S'), 'end_time':NOW.strftime('%Y-%m-%d %H:%M:%S')}})
        common = result.artifact['data']['comparisons']['common_period']['n']
        self.assertEqual(common[first.station_uuid]['count'], 5)
        self.assertAlmostEqual(common[second.station_uuid]['net_change_mm'], 8)
