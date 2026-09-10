"""北斗监测平台 HTTP 客户端。

按用户要求仅封装日监测数据接口（getDailyGNSSDataInfo.php），
不封装实时数据接口（getGNSSDataInfo.php）。
"""

import time

import httpx

from app.beidou.schemas import GnssDataPoint, Station, StationGroup

# SessionUUID 有效期 8 小时，提前一点刷新留出余量
_SESSION_TTL_SECONDS = 8 * 3600
_SESSION_REFRESH_AHEAD = 10 * 60


class BeidouApiError(Exception):
    """北斗平台业务级错误（ResponseCode 非 200）。"""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"北斗平台错误 [{code}]: {message}")


class BeidouClient:
    """封装登录、分组、站点与日监测数据接口。

    用法::

        async with BeidouClient(...) as client:
            groups = await client.get_station_groups()
    """

    def __init__(self, base_url: str, username: str, password: str):
        self._username = username
        self._password = password
        self._client = httpx.AsyncClient(base_url=base_url, timeout=30.0)
        self._session_uuid: str | None = None
        self._session_time: float = 0.0

    async def __aenter__(self) -> "BeidouClient":
        return self

    async def __aexit__(self, *exc_info) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------------
    # 底层请求
    # ------------------------------------------------------------------

    async def _post(self, path: str, payload: dict) -> dict:
        resp = await self._client.post(path, json=payload)
        resp.raise_for_status()
        return resp.json()

    @staticmethod
    def _ensure_ok(resp: dict) -> dict:
        if resp.get("ResponseCode") != "200":
            raise BeidouApiError(
                str(resp.get("ResponseCode", "")), str(resp.get("ResponseMsg", ""))
            )
        return resp

    async def _login(self) -> str:
        resp = await self._post(
            "UserLogin/doLogin.php",
            {"Username": self._username, "Password": self._password},
        )
        self._ensure_ok(resp)
        self._session_uuid = resp["SessionUUID"]
        self._session_time = time.monotonic()
        return self._session_uuid

    async def _ensure_session(self, force: bool = False) -> str:
        expired = (
            self._session_uuid is None
            or time.monotonic() - self._session_time
            > _SESSION_TTL_SECONDS - _SESSION_REFRESH_AHEAD
        )
        if force or expired:
            await self._login()
        assert self._session_uuid is not None
        return self._session_uuid

    async def _request(self, path: str, payload: dict) -> dict:
        """携带会话发起请求；会话过期（400101）时重新登录一次后重试。"""
        payload = {**payload, "SessionUUID": await self._ensure_session()}
        resp = await self._post(path, payload)
        if resp.get("ResponseCode") == "400101":
            payload["SessionUUID"] = await self._ensure_session(force=True)
            resp = await self._post(path, payload)
        return self._ensure_ok(resp)

    # ------------------------------------------------------------------
    # 业务接口
    # ------------------------------------------------------------------

    async def get_station_groups(self) -> list[StationGroup]:
        """获取当前用户有权限访问的全部监测点分组。"""
        resp = await self._request("Station/getStationGroupListInfo.php", {})
        return [
            StationGroup.model_validate(item)
            for item in resp.get("StationGroupList", [])
        ]

    async def get_stations(
        self,
        group_uuid: str | None = None,
        station_name: str | None = None,
        station_status: int | None = None,
    ) -> list[Station]:
        """获取监测点列表（PageSize=-1 一次取全量，避免分页遗漏）。"""
        payload: dict = {
            "PageInfo": {"PageFlag": "StationNameAsc", "PageNumber": 1, "PageSize": -1}
        }
        if group_uuid:
            payload["StationGroupUUID"] = group_uuid
        if station_name:
            payload["StationName"] = station_name
        if station_status is not None:
            payload["StationStatus"] = station_status
        resp = await self._request("Station/getStationListInfo.php", payload)
        return [Station.model_validate(item) for item in resp.get("StationList", [])]

    async def get_daily_data(
        self,
        station_uuid: str,
        begin_time: str,
        end_time: str,
        sampling_frequency: str | None = None,
        sample_times: list[str] | None = None,
    ) -> list[GnssDataPoint]:
        """获取日监测数据（默认每小时一条，可跨天）。

        sampling_frequency: 如 "1h"/"2h"/"3h"/"6h" 或整数分钟。
        sample_times: 固定每日取样时刻，如 ["03:00", "15:00"]，优先于采样频率。
        """
        payload: dict = {
            "StationUUID": station_uuid,
            "BeginTime": begin_time,
            "EndTime": end_time,
        }
        if sample_times:
            payload["SampleTimes"] = sample_times
        elif sampling_frequency:
            payload["SamplingFrequency"] = sampling_frequency
        resp = await self._request("GNSSData/getDailyGNSSDataInfo.php", payload)
        return [GnssDataPoint.model_validate(item) for item in resp.get("Data", [])]
