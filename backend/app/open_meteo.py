"""Open-Meteo 公开天气接口：天气工具与测点页降雨共用的地址与超时。"""

FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_ENDPOINT = "https://archive-api.open-meteo.com/v1/archive"
# 一年逐小时降水的历史请求响应约数秒到十余秒，留出余量。
HTTP_TIMEOUT_SECONDS = 30
