"""平台HTTP边界的当前数据形状及单次执行台账复用。"""
import asyncio
import unittest

import httpx

from app.beidou.client import BeidouClient
from app.monitoring_data import monitoring_scope
from app.observations import normalize_observations, station_reference


class BeidouClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_station_catalog_is_shared_within_one_run_only(self):
        requests = []

        async def respond(request):
            requests.append(request.url.path)
            if request.url.path.endswith('doLogin.php'):
                return httpx.Response(200, json={'ResponseCode': '200', 'SessionUUID': 'test-session'})
            await asyncio.sleep(0)
            return httpx.Response(200, json={'ResponseCode': '200', 'StationList': [{
                'StationUUID': 'station-A', 'StationName': 'A', 'StationGroupUUID': 'g',
                'StationGroupName': 'G', 'StationN0': None, 'StationE0': 200, 'Latitude': None,
            }]})

        def client_for():
            client = BeidouClient('https://monitoring.invalid/', 'account-A', 'test-password')
            client._client = httpx.AsyncClient(base_url='https://monitoring.invalid/', transport=httpx.MockTransport(respond))
            return client

        async with monitoring_scope(client_factory=client_for) as data:
            values = await asyncio.gather(data.stations(), data.resolve_station('A'))
            self.assertEqual(values[0][0].station_uuid, values[1].station_uuid)
            self.assertIsNone(station_reference(values[1])['n'])
        async with monitoring_scope(client_factory=client_for) as data:
            await data.stations()
        self.assertEqual(sum(path.endswith('getStationListInfo.php') for path in requests), 2)

    async def test_null_and_nonfinite_coordinates_reach_shared_quality_rules(self):
        raw = [
            {'DataTime': '2026-11-01 02:00:00', 'PJKInfoN': 100.002, 'PJKInfoE': None, 'PJKInfoU': 'nan'},
            {'DataTime': '2026-11-01 00:00:00', 'PJKInfoN': '100', 'PJKInfoE': '200', 'PJKInfoU': ''},
        ]

        def respond(request):
            if request.url.path.endswith('doLogin.php'):
                return httpx.Response(200, json={'ResponseCode': '200', 'SessionUUID': 'test-session'})
            return httpx.Response(200, json={'ResponseCode': '200', 'Data': raw})

        async with BeidouClient('https://monitoring.invalid/', 'test', 'test') as client:
            await client._client.aclose()
            client._client = httpx.AsyncClient(base_url='https://monitoring.invalid/', transport=httpx.MockTransport(respond))
            samples = await client.get_daily_data('station-A', '2026-11-01 00:00:00', '2026-11-01 02:00:00')
        points, quality = normalize_observations(samples)
        self.assertEqual([item.n for item in points], [100, 100.002])
        self.assertIsNone(points[-1].e)
        self.assertIsNone(points[-1].u)
        self.assertEqual(quality['invalid_values']['u'], 1)

    async def test_concurrent_cold_requests_share_block_lock_per_session(self):
        data_requests = 0

        async def respond(request):
            nonlocal data_requests
            if request.url.path.endswith('doLogin.php'):
                return httpx.Response(200, json={'ResponseCode': '200', 'SessionUUID': 'test-session'})
            if request.url.path.endswith('getStationListInfo.php'):
                return httpx.Response(200, json={'ResponseCode': '200', 'StationList': [{
                    'StationUUID': 'station-lock', 'StationName': 'LockStation', 'StationGroupUUID': 'g',
                    'StationGroupName': 'G', 'StationType': 3, 'StationN0': 100, 'StationE0': 200,
                }]})
            data_requests += 1
            await asyncio.sleep(0.02)
            return httpx.Response(200, json={'ResponseCode': '200', 'Data': [
                {'DataTime': '2026-11-01 00:00:00', 'PJKInfoN': 100.001, 'PJKInfoE': 200.001, 'PJKInfoU': 300},
            ]})

        def client_for():
            client = BeidouClient('https://monitoring.invalid/', 'account-lock', 'test-password')
            client._client = httpx.AsyncClient(base_url='https://monitoring.invalid/', transport=httpx.MockTransport(respond))
            return client

        async def query_once():
            async with monitoring_scope(session_id='shared-lock-session', client_factory=client_for) as data:
                station = await data.resolve_station('LockStation')
                return await data.displacement(station, '2026-11-01 00:00:00', '2026-11-02 00:00:00', sampling='daily')

        first, second = await asyncio.gather(query_once(), query_once())
        self.assertEqual(data_requests, 1)
        self.assertEqual(len(first.observations), len(second.observations))
