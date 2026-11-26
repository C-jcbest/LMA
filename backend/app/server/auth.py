"""单账号访问保护：账号密码来自配置，登录后发放带签名与有效期的 HttpOnly Cookie。

只服务于单人部署，不是用户体系。未配置 AUTH_PASSWORD 时不启用保护（本地开发与测试），
生产部署由流水线检查受保护接口返回 401。
"""

import asyncio
import hashlib
import hmac
import time

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from app.config import Settings

SESSION_COOKIE = "lma_session"
SESSION_DAYS = 7
PUBLIC_PATHS = {"/health", "/auth/login", "/auth/logout", "/auth/session"}
_FAILED_LOGIN_DELAY_SECONDS = 1.0


class LoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=200)


def auth_enabled(settings: Settings) -> bool:
    return bool(settings.auth_password)


def _signature(settings: Settings, payload: str) -> str:
    key = f"{settings.auth_secret}\n{settings.auth_username}\n{settings.auth_password}".encode()
    return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()


def issue_token(settings: Settings, now: float | None = None) -> str:
    expires_at = int((now or time.time()) + SESSION_DAYS * 86400)
    payload = str(expires_at)
    return f"{payload}.{_signature(settings, payload)}"


def token_expires_at(settings: Settings, token: str | None) -> int | None:
    if not token or "." not in token:
        return None
    payload, signature = token.split(".", 1)
    if not hmac.compare_digest(signature, _signature(settings, payload)):
        return None
    try:
        return int(payload)
    except ValueError:
        return None


def token_valid(settings: Settings, token: str | None, now: float | None = None) -> bool:
    expires_at = token_expires_at(settings, token)
    return expires_at is not None and expires_at > (now or time.time())


def _set_session_cookie(response: Response, settings: Settings) -> None:
    response.set_cookie(
        SESSION_COOKIE, issue_token(settings), max_age=SESSION_DAYS * 86400,
        httponly=True, secure=True, samesite="lax", path="/",
    )


def require_login(settings: Settings):
    """作为全局依赖挂在应用上；不用 HTTP middleware，避免包裹 SSE 流和取消语义。"""

    async def dependency(request: Request, response: Response) -> None:
        if not auth_enabled(settings) or request.url.path in PUBLIC_PATHS:
            return
        token = request.cookies.get(SESSION_COOKIE)
        now = time.time()
        expires_at = token_expires_at(settings, token)
        if expires_at is None or expires_at <= now:
            raise HTTPException(401, "请先登录。")
        # 活跃访问时滑动续期（剩余有效期少于 6 天时顺延 7 天），避免日常使用途中被 401 打断。
        if expires_at - now < (SESSION_DAYS - 1) * 86400:
            _set_session_cookie(response, settings)

    return dependency


def auth_router(settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/auth")

    @router.get("/session")
    async def session(request: Request, response: Response):
        token = request.cookies.get(SESSION_COOKIE)
        now = time.time()
        expires_at = token_expires_at(settings, token) if auth_enabled(settings) else None
        authenticated = not auth_enabled(settings) or (expires_at is not None and expires_at > now)
        if auth_enabled(settings) and authenticated and expires_at is not None and expires_at - now < (SESSION_DAYS - 1) * 86400:
            _set_session_cookie(response, settings)
        return {"enabled": auth_enabled(settings), "authenticated": authenticated}

    @router.post("/login", status_code=204)
    async def login(body: LoginInput, response: Response):
        if not auth_enabled(settings):
            return
        username_ok = hmac.compare_digest(body.username.encode(), settings.auth_username.encode())
        password_ok = hmac.compare_digest(body.password.encode(), settings.auth_password.encode())
        if not (username_ok and password_ok):
            await asyncio.sleep(_FAILED_LOGIN_DELAY_SECONDS)
            raise HTTPException(401, "账号或密码错误。")
        _set_session_cookie(response, settings)

    @router.post("/logout", status_code=204)
    async def logout(response: Response):
        response.delete_cookie(SESSION_COOKIE, httponly=True, secure=True, samesite="lax", path="/")

    return router
