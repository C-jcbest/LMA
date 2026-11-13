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
# 不需要登录即可访问：健康检查供容器与部署脚本使用，登录接口本身也必须公开。
PUBLIC_PATHS = {"/health", "/auth/login", "/auth/logout", "/auth/session"}
# 登录失败后固定等待，单账号场景下足以拖慢在线猜测。
_FAILED_LOGIN_DELAY_SECONDS = 1.0


class LoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=200)


def auth_enabled(settings: Settings) -> bool:
    return bool(settings.auth_password)


def _signature(settings: Settings, payload: str) -> str:
    # 账号或密码改变后旧 Cookie 自动失效，不需要另外维护会话表。
    key = f"{settings.auth_secret}\n{settings.auth_username}\n{settings.auth_password}".encode()
    return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()


def issue_token(settings: Settings, now: float | None = None) -> str:
    expires_at = int((now or time.time()) + SESSION_DAYS * 86400)
    payload = str(expires_at)
    return f"{payload}.{_signature(settings, payload)}"


def token_valid(settings: Settings, token: str | None, now: float | None = None) -> bool:
    if not token or "." not in token:
        return False
    payload, signature = token.split(".", 1)
    if not hmac.compare_digest(signature, _signature(settings, payload)):
        return False
    try:
        expires_at = int(payload)
    except ValueError:
        return False
    return expires_at > (now or time.time())


def require_login(settings: Settings):
    """作为全局依赖挂在应用上；不用 HTTP middleware，避免包裹 SSE 流和取消语义。"""

    async def dependency(request: Request) -> None:
        if not auth_enabled(settings) or request.url.path in PUBLIC_PATHS:
            return
        if not token_valid(settings, request.cookies.get(SESSION_COOKIE)):
            raise HTTPException(401, "请先登录。")

    return dependency


def auth_router(settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/auth")

    @router.get("/session")
    async def session(request: Request):
        authenticated = not auth_enabled(settings) or token_valid(settings, request.cookies.get(SESSION_COOKIE))
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
        response.set_cookie(
            SESSION_COOKIE, issue_token(settings), max_age=SESSION_DAYS * 86400,
            httponly=True, secure=True, samesite="strict", path="/",
        )

    @router.post("/logout", status_code=204)
    async def logout(response: Response):
        response.delete_cookie(SESSION_COOKIE, httponly=True, secure=True, samesite="strict", path="/")

    return router
