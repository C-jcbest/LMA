"""访问保护：登录发放 Cookie，未登录不能访问业务接口，健康检查保持公开。

不启动应用生命周期：鉴权依赖在路由处理前拒绝请求，不需要数据库。
"""

import asyncio
import unittest
from unittest.mock import patch

import httpx

from app.config import Settings
from app.server import auth
from app.server.api import create_app

PASSWORD = "INVALID_TEST_PASSWORD"
SECRET = "INVALID_TEST_SECRET_" + "x" * 32


def protected_settings(**overrides) -> Settings:
    values = {"_env_file": None, "context_model_context": 100000, "auth_password": PASSWORD, "auth_secret": SECRET}
    return Settings(**{**values, **overrides})


class AuthTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(protected_settings())), base_url="https://testserver",
        )
        self.addAsyncCleanup(self.client.aclose)

    async def test_business_api_requires_login(self):
        response = await self.client.get("/sessions")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["detail"], "请先登录。")

    async def test_login_grants_access_and_logout_revokes_it(self):
        session = await self.client.get("/auth/session")
        self.assertEqual(session.json(), {"enabled": True, "authenticated": False})

        login = await self.client.post("/auth/login", json={"username": "admin", "password": PASSWORD})
        self.assertEqual(login.status_code, 204)
        cookie = login.headers["set-cookie"].lower()
        for attribute in ("httponly", "secure", "samesite=strict", "path=/"):
            self.assertIn(attribute, cookie)
        session = await self.client.get("/auth/session")
        self.assertEqual(session.json(), {"enabled": True, "authenticated": True})

        await self.client.post("/auth/logout")
        session = await self.client.get("/auth/session")
        self.assertFalse(session.json()["authenticated"])

    async def test_wrong_credentials_are_rejected_without_cookie(self):
        with patch.object(auth, "_FAILED_LOGIN_DELAY_SECONDS", 0):
            for body in ({"username": "admin", "password": "wrong"}, {"username": "root", "password": PASSWORD}):
                response = await self.client.post("/auth/login", json=body)
                self.assertEqual(response.status_code, 401)
                self.assertEqual(response.json()["detail"], "账号或密码错误。")
                self.assertNotIn("set-cookie", response.headers)

    def test_token_rejects_tampering_expiry_and_password_change(self):
        settings = protected_settings()
        token = auth.issue_token(settings, now=1000)
        self.assertTrue(auth.token_valid(settings, token, now=1001))
        expires_at, signature = token.split(".")
        self.assertFalse(auth.token_valid(settings, f"{int(expires_at) + 86400}.{signature}", now=1001))
        self.assertFalse(auth.token_valid(settings, token, now=1000 + auth.SESSION_DAYS * 86400 + 1))
        self.assertFalse(auth.token_valid(protected_settings(auth_password="CHANGED"), token, now=1001))
        self.assertFalse(auth.token_valid(settings, None))
        self.assertFalse(auth.token_valid(settings, "not-a-token"))

    def test_password_without_long_secret_refuses_to_start(self):
        with self.assertRaises(ValueError):
            create_app(protected_settings(auth_secret="short"))


class AuthDisabledTests(unittest.TestCase):
    def test_without_password_protection_is_off(self):
        settings = Settings(_env_file=None, context_model_context=100000)

        async def check():
            transport = httpx.ASGITransport(app=create_app(settings))
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                return (await client.get("/auth/session")).json()

        self.assertEqual(asyncio.run(check()), {"enabled": False, "authenticated": True})


if __name__ == "__main__":
    unittest.main()
