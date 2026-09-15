"""官方重试 middleware 的异常分类：只重试明确的瞬时失败。"""

import httpx
from openai import APIConnectionError, APIStatusError


def is_transient_error(exc: BaseException) -> bool:
    if isinstance(exc, BaseExceptionGroup):
        return bool(exc.exceptions) and all(is_transient_error(item) for item in exc.exceptions)
    if isinstance(exc, (TimeoutError, ConnectionError, httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)):
        return True
    if isinstance(exc, APIConnectionError):
        return not isinstance(exc.__cause__, (httpx.InvalidURL, httpx.UnsupportedProtocol, httpx.LocalProtocolError))
    if isinstance(exc, APIStatusError):
        return exc.status_code in {408, 429, 500, 502, 503, 504}
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        return status in {408, 429, 500, 502, 503, 504}
    return False
