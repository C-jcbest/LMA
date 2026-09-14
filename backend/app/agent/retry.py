"""LangGraph 节点重试分类：只重试明确的瞬时失败。"""

import httpx


def is_transient_error(exc: BaseException) -> bool:
    if isinstance(exc, BaseExceptionGroup):
        return any(is_transient_error(item) for item in exc.exceptions)
    if isinstance(exc, (TimeoutError, ConnectionError, httpx.TimeoutException, httpx.NetworkError)):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        return status == 429 or status >= 500
    return False
