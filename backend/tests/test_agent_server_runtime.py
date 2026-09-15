"""隔离 Agent Server E2E：LMA_RUN_SERVER_E2E=1 时实际启动官方服务。

生产 graph.py:graph -> 官方 Agent -> 真正 HTTP 模型/北斗 stub -> SDK stream。
临时目录运行，配置均为无效测试凭据，不读取项目 .env，不改写已有服务。
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
from langgraph_sdk import get_client


class StubHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, data, status=200):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.endswith("doLogin.php"):
            return self.send_json({"ResponseCode": "200", "SessionUUID": "INVALID_TEST_SESSION"})
        if self.path.endswith("getStationGroupListInfo.php"):
            self.server.group_calls += 1
            if self.server.group_calls == 1:
                return self.send_json({"error": "transient test error"}, 503)
            return self.send_json({"ResponseCode": "200", "StationGroupList": [{
                "StationGroupUUID": "INVALID_GROUP", "StationGroupName": "测试监测组", "StationCount": 2,
            }]})
        if self.path.endswith("getStationListInfo.php"):
            return self.send_json({"ResponseCode": "200", "StationList": []})
        if self.path != "/v1/chat/completions":
            return self.send_json({"error": "unknown endpoint"}, 404)
        self.server.model_calls += 1
        self.server.model_inputs.append(body)
        if self.server.model_calls == 1:
            return self.send_json({"error": {"message": "transient stub error", "type": "server_error"}}, 503)
        messages = body["messages"]
        if messages[0]["content"].startswith("你负责提取滑坡连续监测会话"):
            self.server.summary_calls += 1
            if self.server.summary_calls == 1:
                return self.send_json({"error": {"message": "summary transient error", "type": "server_error"}}, 503)
            return self.send_json({"id": "summary-test", "object": "chat.completion", "created": 1,
                "model": "lma-test-model", "choices": [{"index": 0,
                    "message": {"role": "assistant", "content": "内部摘要：测试监测组；2026-09-15；证据有限。"},
                    "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1000, "completion_tokens": 20, "total_tokens": 1020}})
        last_user = max(i for i, m in enumerate(messages) if m["role"] == "user")
        missing_station = "不存在的监测点" in messages[last_user]["content"]
        looping = "循环分组" in messages[last_user]["content"]
        needs_tool = looping or (("分组" in messages[last_user]["content"] or missing_station)
                      and not any(m["role"] == "tool" for m in messages[last_user + 1:]))
        deltas = ([{"role": "assistant", "content": "", "tool_calls": [{
            "index": 0, "id": "test-call", "type": "function",
            "function": {"name": "get_daily_gnss_data" if missing_station else "list_station_groups",
                         "arguments": json.dumps({"station_name_or_uuid": "不存在的监测点",
                            "begin_time": "2026-09-01 00:00:00", "end_time": "2026-09-02 00:00:00"}) if missing_station else "{}"},
        }]}] if needs_tool else [
            {"role": "assistant", "reasoning_content": "检查工具证据"},
            {"content": "测试监测组包含2个监测点。"},
        ])
        if not body.get("stream"):
            message = {"role": "assistant", "content": "测试监测组包含2个监测点。",
                       "reasoning_content": "检查工具证据"}
            if needs_tool:
                message = {**deltas[0], "tool_calls": [
                    {k: v for k, v in deltas[0]["tool_calls"][0].items() if k != "index"},
                ]}
            return self.send_json({"id": f"stub-{self.server.model_calls}",
                "object": "chat.completion", "created": 1, "model": "lma-test-model",
                "choices": [{"index": 0, "message": message,
                             "finish_reason": "tool_calls" if needs_tool else "stop"}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for delta in deltas + [{}]:
            chunk = {"id": f"stub-{self.server.model_calls}", "object": "chat.completion.chunk",
                     "created": 1, "model": "lma-test-model", "choices": [{
                         "index": 0, "delta": delta,
                         "finish_reason": ("tool_calls" if needs_tool else "stop") if not delta else None,
                     }]}
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()
        usage = {"id": f"stub-{self.server.model_calls}", "object": "chat.completion.chunk",
                 "created": 1, "model": "lma-test-model", "choices": [],
                 "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}}
        self.wfile.write(("data: " + json.dumps(usage) + "\n\ndata: [DONE]\n\n").encode("utf-8"))
        self.wfile.flush()


@unittest.skipUnless(os.environ.get("LMA_RUN_SERVER_E2E") == "1", "需显式启用隔离 Agent Server E2E")
class AgentServerRuntimeTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="lma-runtime-e2e-")
        directory = Path(cls.temp.name)
        backend = Path(__file__).resolve().parents[1]
        cls.stub = ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
        cls.stub.group_calls = 0
        cls.stub.model_calls = 0
        cls.stub.summary_calls = 0
        cls.stub.model_inputs = []
        threading.Thread(target=cls.stub.serve_forever, daemon=True).start()
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        cls.url = f"http://127.0.0.1:{port}"
        stub_url = f"http://127.0.0.1:{cls.stub.server_port}"
        config = {"dependencies": [str(backend)], "graphs": {
            "lma-agent": "app.agent.graph:graph",
        }, "env": {
            "LLM_BASE_URL": stub_url + "/v1", "LLM_API_KEY": "INVALID_TEST_KEY",
            "LLM_MODEL": "lma-test-model", "LLM_THINKING": "true",
            "RECOMMEND_ENABLED": "false", "CONTEXT_MODEL_CONTEXT": "1048576",
            "AGENT_MODEL_RUN_LIMIT": "3", "AGENT_TOOL_RUN_LIMIT": "2",
            "CONTEXT_TOKEN_THRESHOLD": "50000", "CONTEXT_KEEP_TOKENS": "1000",
            "BEIDOU_API_BASE_URL": stub_url, "BEIDOU_USERNAME": "INVALID_TEST_USER",
            "BEIDOU_PASSWORD": "INVALID_TEST_PASSWORD", "LANGSMITH_TRACING": "false",
        }}
        config_path = directory / "langgraph.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        cls.log_path = directory / "server.log"
        cls.log = cls.log_path.open("w", encoding="utf-8")
        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "PYTHONPATH": str(backend),
               "LANGSMITH_TRACING": "false", "LANGGRAPH_API_NO_USAGE_STATS": "1"}
        cls.process = subprocess.Popen([
            str(Path(sys.executable).with_name("langgraph.exe")), "dev", "--config", str(config_path),
            "--port", str(port), "--no-browser", "--no-reload", "--allow-blocking",
        ], cwd=directory, env=env, stdout=cls.log, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if cls.process.poll() is not None:
                    raise RuntimeError(cls.log_path.read_text(encoding="utf-8"))
                try:
                    if httpx.get(cls.url + "/ok", timeout=0.5).status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
                time.sleep(0.2)
            raise RuntimeError("Agent Server 启动超时\n" + cls.log_path.read_text(encoding="utf-8"))
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        try:
            cls.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait(timeout=10)
        cls.log.close()
        cls.stub.shutdown()
        cls.stub.server_close()
        cls.temp.cleanup()

    async def test_production_factory_stream_tool_retry_and_thread_restore(self):
        client = get_client(url=self.url)
        thread = await client.threads.create()
        thread_id = thread["thread_id"]
        events = [event async for event in client.runs.stream(thread_id, "lma-agent", input={
            "messages": [{"role": "user", "content": "查询监测分组"}],
        }, stream_mode=["messages", "updates", "values"])]
        errors = [event.data for event in events if event.event == "error"]
        self.assertFalse(errors, errors)
        self.assertTrue(any(event.event.startswith("messages") for event in events))
        self.assertTrue(any(event.event == "updates" and "tools" in event.data for event in events))
        state = await client.threads.get_state(thread_id)
        messages = state["values"]["messages"]
        self.assertEqual([m["type"] for m in messages], ["human", "ai", "tool", "ai"])
        self.assertEqual(messages[2]["status"], "success")
        self.assertIn("测试监测组", messages[2]["content"])
        self.assertIn("2个监测点", messages[-1]["content"])
        self.assertIn("created_at", messages[0]["additional_kwargs"])
        self.assertEqual(state["values"]["context_usage"]["input_tokens"], 100)
        self.assertEqual(self.stub.group_calls, 2)
        self.assertEqual(self.stub.model_calls, 3)
        self.assertTrue(all(body.get("enable_thinking") is True for body in self.stub.model_inputs))
        # 新 SDK 客户端从 Thread 恢复，然后发送第二轮。
        restored = get_client(url=self.url)
        second = await restored.runs.wait(thread_id, "lma-agent", input={
            "messages": [{"role": "user", "content": "继续说明"}],
        })
        self.assertEqual(len(second["messages"]), 6)
        self.assertTrue(any(m["role"] == "tool" for m in self.stub.model_inputs[-1]["messages"]))
        # 通过真实 Server 触发生产官方摘要，随后从 Thread 恢复压缩结果。
        history = []
        for index in range(3):
            history.extend([{"role": "user", "content": f"历史查询{index} 2026-09-15"},
                            {"role": "assistant", "content": "已查询测试监测组；" + "x" * 100000}])
        history.append({"role": "user", "content": "继续核实"})
        compressed_events = [event async for event in client.runs.stream(thread_id, "lma-agent",
            input={"messages": history}, stream_mode=["messages", "values"])]
        self.assertFalse([event.data for event in compressed_events if event.event == "error"])
        self.assertEqual(self.stub.summary_calls, 2)
        summary_inputs = [body for body in self.stub.model_inputs
                          if body["messages"][0]["content"].startswith("你负责提取滑坡连续监测会话")]
        self.assertTrue(all(not body.get("stream") and not body.get("enable_thinking")
                            for body in summary_inputs))
        compressed = (await client.threads.get_state(thread_id))["values"]
        self.assertNotIn("context_summary", compressed)
        self.assertEqual(compressed["messages"][0]["additional_kwargs"]["lc_source"], "summarization")
        self.assertIn("2026-09-15", compressed["messages"][0]["content"])
        for event in compressed_events:
            if event.event.startswith("messages") and isinstance(event.data, list):
                for message in event.data:
                    if isinstance(message, dict) and message.get("type") == "ai":
                        self.assertNotIn("内部摘要", message.get("content", ""))
        self.assertEqual(compressed["context_usage"]["input_tokens"], 100)
        rejected = await client.runs.wait(thread_id, "lma-agent", input={
            "messages": [{"role": "user", "content": "查询不存在的监测点"}]})
        failed_tool = next(m for m in reversed(rejected["messages"]) if m["type"] == "tool")
        self.assertEqual(failed_tool["status"], "error")
        self.assertIn("未找到", failed_tool["artifact"]["data"]["message"])
        self.assertEqual(failed_tool["artifact"]["error"]["category"], "business")
        self.assertNotIn("INVALID_TEST_SESSION", str(failed_tool))
        limited_events = [event async for event in client.runs.stream(thread_id, "lma-agent",
            input={"messages": [{"role": "user", "content": "循环分组查询"}]}, stream_mode=["values", "updates"])]
        limit_errors = [event.data for event in limited_events if event.event == "error"]
        self.assertTrue(limit_errors)
        self.assertIn("ModelCallLimitExceededError", str(limit_errors))
        limited = (await client.threads.get_state(thread_id))["values"]
        self.assertTrue(any(m.get("status") == "error" and
            m.get("content") == "Tool call limit exceeded. Do not make additional tool calls."
            for m in limited["messages"]))
        await client.threads.delete(thread_id)
