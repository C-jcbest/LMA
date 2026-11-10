"""业务模型评测的合成监测平台；不访问真实站点或外部数据服务。"""
from datetime import datetime, timedelta

from app.beidou.schemas import GnssDataPoint, Station, StationGroup
from app.business_time import TIME_FORMAT
from app.agent.tool_inputs import _parse_frequency_minutes

NOW = datetime(2026, 11, 10, 16)
STATION_A = "11111111-1111-1111-1111-111111111111"
STATION_B = "22222222-2222-2222-2222-222222222222"
NEW_STATION = "33333333-3333-3333-3333-333333333333"


class MonitoringFixture:
    def __init__(self):
        self.requests = []
        self.stations = [
            Station(station_uuid=identifier, station_name=name, station_type=3,
                    group_uuid="evaluation-group", group_name="合成评测组",
                    station_n0="100", station_e0="200", station_u0="300")
            for identifier, name in ((STATION_A, "评测点A"), (STATION_B, "评测点B"), (NEW_STATION, "评测新站"))
        ]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get_station_groups(self):
        return [StationGroup(group_uuid="evaluation-group", group_name="合成评测组", station_count=3)]

    async def get_stations(self, group_uuid=None, station_name=None, station_status=None):
        return [station for station in self.stations
                if (group_uuid is None or station.group_uuid == group_uuid)
                and (station_name is None or station_name in station.station_name)
                and (station_status is None or station.station_status == station_status)]

    async def get_daily_data(self, station_uuid, begin_time, end_time, sample_times=None, sampling_frequency=None):
        self.requests.append({
            "station_uuid": station_uuid, "begin_time": begin_time,
            "end_time": end_time, "sample_times": sample_times,
            "sampling_frequency": sampling_frequency,
        })
        start = max(datetime.strptime(begin_time, TIME_FORMAT), NOW - timedelta(days=90))
        end = min(datetime.strptime(end_time, TIME_FORMAT), NOW)
        if station_uuid == NEW_STATION:
            start = max(start, NOW - timedelta(days=30))
        moment = start.replace(minute=0, second=0)
        if moment < start:
            moment += timedelta(hours=1)
        points = []
        frequency_minutes = _parse_frequency_minutes(sampling_frequency) if sampling_frequency else None
        first_sample = moment
        while moment <= end:
            # B每日缺三小时；A和新站末端单点突变，尚无保持证据。
            missing = station_uuid == STATION_B and moment.hour in {3, 4, 5}
            selected = not sample_times or moment.strftime("%H:%M") in sample_times
            if not sample_times and frequency_minutes:
                elapsed_minutes = (moment - first_sample).total_seconds() / 60
                selected = elapsed_minutes % frequency_minutes == 0
            if selected and not missing:
                age_days = (moment - (NOW - timedelta(days=90))).total_seconds() / 86400
                north = 100 + age_days * 0.0002 if station_uuid == STATION_B else 100.0
                if station_uuid != STATION_B and moment == NOW:
                    north += 0.1
                points.append(GnssDataPoint(
                    data_time=moment.strftime(TIME_FORMAT), n=str(north), e="200", u="300",
                ))
            moment += timedelta(hours=1)
        return points
