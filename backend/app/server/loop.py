"""Windows Psycopg 的公开 asyncio Selector loop 工厂。"""

import asyncio


def create_loop():
    return asyncio.SelectorEventLoop()
