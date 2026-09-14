"""统一当前业务时间；不依赖宿主机的本地时区。

当前监测业务采用北京时间 UTC+08:00。这里只生成当前时间，
不用于转换历史夏令时日期；平台无偏移时间字符串保留其业务本地时间语义。
"""

from datetime import datetime, timedelta, timezone

BUSINESS_TIMEZONE = "Asia/Shanghai"
BUSINESS_TZ = timezone(timedelta(hours=8), BUSINESS_TIMEZONE)
TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


def business_now() -> datetime:
    return datetime.now(BUSINESS_TZ)
