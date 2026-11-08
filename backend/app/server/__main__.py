"""本地开发入口；容器直接运行 Uvicorn，固定一个 worker。"""

import sys

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "app.server.api:app", host="127.0.0.1", port=2025,
        loop="app.server.loop:create_loop" if sys.platform == "win32" else "asyncio",
    )
