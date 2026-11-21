"""使用真实 Langfuse SDK 和本地 OTLP 接收端验证调查追踪，不访问 Cloud 或真实模型。"""

import asyncio
from contextlib import contextmanager
import gzip
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Queue
from tempfile import TemporaryDirectory
from pathlib import Path
from threading import Thread
from unittest import TestCase, IsolatedAsyncioTestCase
from uuid import uuid4

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from pydantic import ValidationError

from app.agent.graph import create_lma_agent
from app.config import Settings
from app.observability import AgentTracing
from runtime_fixtures import ScriptedModel, call


class TraceReceiver(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        if self.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        request = ExportTraceServiceRequest.FromString(body)
        for resource in request.resource_spans:
            for scope in resource.scope_spans:
                for span in scope.spans:
                    self.server.spans.put(span)
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


def attributes(span):
    return {attribute.key: attribute.value.string_value for attribute in span.attributes}


@contextmanager
def trace_receiver():
    server = ThreadingHTTPServer(("127.0.0.1", 0), TraceReceiver)
    server.spans = Queue()
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


class TracingConfigTests(TestCase):
    def test_disabled_config_needs_no_cloud_credentials_and_preserves_invocation(self):
        with TemporaryDirectory() as directory:
            env = Path(directory) / ".env"
            env.write_text("CONTEXT_MODEL_CONTEXT=100000\nLANGFUSE_ENABLED=false\nLANGFUSE_BASE_URL=\n", encoding="utf-8")
            tracing = AgentTracing(Settings(_env_file=env))
        config = {"configurable": {"thread_id": "session", "checkpoint_id": "checkpoint"}}
        with tracing.run(config, session_id="session", run_id="run") as trace:
            self.assertEqual(trace.config, {**config, "run_id": "run"})
            self.assertIsNone(trace.observation)
            trace.finish("success")
        self.assertIsNone(tracing.client)
        self.assertNotIn("run_id", config)

    def test_enabled_config_requires_explicit_destination_and_project_credentials(self):
        for missing in ("langfuse_base_url", "langfuse_public_key", "langfuse_secret_key"):
            values = dict(
                _env_file=None, context_model_context=100000, langfuse_enabled=True,
                langfuse_base_url="https://cloud.langfuse.com",
                langfuse_public_key="public", langfuse_secret_key="secret",
            )
            values[missing] = ""
            with self.subTest(missing=missing), self.assertRaisesRegex(ValidationError, "开启 Langfuse 必须配置"):
                Settings(**values)
        for destination in ("file:///tmp/trace", "https://user:password@example.com", "https://example.com?token=secret"):
            with self.subTest(destination=destination), self.assertRaises(ValidationError):
                Settings(_env_file=None, context_model_context=100000, langfuse_base_url=destination)


class AgentTracingTests(IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = cls.enterClassContext(trace_receiver())

    def setUp(self):
        self.settings = Settings(
            _env_file=None, context_model_context=100000, langfuse_enabled=True,
            langfuse_base_url=f"http://127.0.0.1:{self.server.server_port}",
            langfuse_public_key=f"pk-lf-{uuid4()}", langfuse_secret_key="sk-lf-synthetic-secret",
            llm_api_key="synthetic-model-key", beidou_password="synthetic-platform-password",
        )
        self.tracing = AgentTracing(self.settings)
        self.addCleanup(self.tracing.client.shutdown)

    async def exported_spans(self):
        await asyncio.to_thread(self.tracing.client.flush)
        spans = []
        while not self.server.spans.empty():
            spans.append(self.server.spans.get_nowait())
        return spans

    async def test_agent_model_usage_tool_failure_and_secret_masking_reach_otlp(self):
        @tool
        def station() -> ToolMessage:
            """返回部分取数失败。"""
            return ToolMessage(content="数据不完整", status="error", tool_call_id="call-1")

        model = ScriptedModel(script=[call(), AIMessage(
            content="缺少完整数据，暂不下结论",
            usage_metadata={"input_tokens": 23, "output_tokens": 7, "total_tokens": 30},
        )])
        agent = create_lma_agent(model, agent_tools=[station], summary_model=ScriptedModel(script=[]), retry_delay=0)
        run_id = str(uuid4())
        with self.tracing.run({}, session_id="investigation-session", run_id=run_id, input="查询") as trace:
            result = await agent.ainvoke({"messages": [HumanMessage(content="查询")]}, trace.config)
            try:
                with self.tracing.client.start_as_current_observation(name="upstream-error"):
                    raise ValueError(f"failed: {self.settings.beidou_password}")
            except ValueError:
                pass
            trace.finish("success", result["messages"])

        spans = await self.exported_spans()
        root = next(span for span in spans if span.name == "lma-investigation")
        self.assertEqual(attributes(root)["langfuse.observation.output"], "缺少完整数据，暂不下结论")
        self.assertEqual(attributes(root)["session.id"], "investigation-session")
        self.assertEqual(json.loads(attributes(root)["langfuse.observation.metadata.lma_run_id"]), run_id)
        self.assertEqual(json.loads(attributes(root)["langfuse.observation.metadata.lma_run_status"]), "success")
        self.assertTrue(any(span.name == "station" and attributes(span).get("langfuse.observation.level") == "ERROR" for span in spans))
        usages = [json.loads(attributes(span)["langfuse.observation.usage_details"])
                  for span in spans if "langfuse.observation.usage_details" in attributes(span)]
        self.assertTrue(any(usage.get("input") == 23 and usage.get("output") == 7 for usage in usages))
        self.assertEqual({span.trace_id for span in spans}, {root.trace_id})
        wire_data = str(spans)
        self.assertNotIn(self.settings.beidou_password, wire_data)
        self.assertIn("[REDACTED]", wire_data)

    async def test_concurrent_sessions_and_run_ids_remain_separate(self):
        async def investigate(session_id, status):
            run_id = str(uuid4())
            with self.tracing.run({}, session_id=session_id, run_id=run_id) as trace:
                await asyncio.sleep(0)
                trace.finish(status)
            return run_id

        run_ids = await asyncio.gather(
            investigate("session-a", "cancelled"), investigate("session-b", "error"),
        )
        spans = await self.exported_spans()
        roots = [span for span in spans if span.name == "lma-investigation"]
        self.assertEqual(len(roots), 2)
        self.assertEqual(len({span.trace_id for span in roots}), 2)
        self.assertEqual({attributes(span)["langfuse.observation.status_message"] for span in roots}, {"cancelled", "error"})
        self.assertTrue(all(any(run_id in str(span) for span in roots) for run_id in run_ids))
        by_session = {attributes(span)["session.id"]: attributes(span) for span in roots}
        self.assertEqual(by_session["session-a"]["langfuse.observation.level"], "WARNING")
        self.assertEqual(by_session["session-b"]["langfuse.observation.level"], "ERROR")

    async def test_cancelled_stream_closes_trace_and_retains_cancelled_status(self):
        started = asyncio.Event()

        @tool
        async def station() -> str:
            """等待取数，让测试在实际执行中停止。"""
            started.set()
            await asyncio.Event().wait()
            return "不应完成"

        agent = create_lma_agent(
            ScriptedModel(script=[call()]), agent_tools=[station],
            summary_model=ScriptedModel(script=[]),
        )

        async def investigate():
            with self.tracing.run({}, session_id="cancelled-session", run_id=str(uuid4())) as trace:
                try:
                    async for _ in agent.astream({"messages": [HumanMessage(content="查询")]}, trace.config):
                        pass
                finally:
                    trace.finish("cancelled")

        task = asyncio.create_task(investigate())
        await asyncio.wait_for(started.wait(), timeout=5)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        spans = await self.exported_spans()
        root = next(span for span in spans if span.name == "lma-investigation")
        self.assertEqual(attributes(root)["langfuse.observation.level"], "WARNING")
        self.assertEqual(attributes(root)["langfuse.observation.status_message"], "cancelled")
        self.assertGreater(root.end_time_unix_nano, 0)
