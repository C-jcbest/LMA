"""调查调用链：官方 Langfuse callback 采集模型与工具，本层维护 Run 关联与结束状态。"""

import base64
import json
from collections.abc import Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from urllib.parse import quote

from langfuse import Langfuse, LangfuseAgent, propagate_attributes
from langfuse.langchain import CallbackHandler
from opentelemetry.exporter.otlp.proto.http import Compression
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import Event, ReadableSpan
from opentelemetry.trace import Status

from app.config import Settings


@dataclass
class RunTrace:
    config: dict
    observation: LangfuseAgent | None = None

    def finish(self, status: str, messages=()):
        if self.observation is None:
            return
        level = "DEFAULT"
        if status == "error":
            level = "ERROR"
        elif status == "cancelled":
            level = "WARNING"
        output = None
        if status == "success":
            for message in reversed(messages):
                if message.type == "ai" and message.text.strip():
                    output = message.text
                    break
        self.observation.update(
            metadata={"lma_run_status": status},
            level=level, status_message=status, output=output,
        )


class RedactingSpanExporter(OTLPSpanExporter):
    """保留官方 OTLP 传输，只在发送前净化追踪属性、异常事件与状态描述。"""

    def __init__(self, *, secrets: tuple[str, ...], **kwargs):
        variants = set()
        for secret in secrets:
            variants.update((secret, json.dumps(secret)[1:-1], quote(secret, safe="")))
        self.secrets = tuple(sorted(variants, key=len, reverse=True))
        super().__init__(**kwargs)

    def redact(self, value):
        if isinstance(value, str):
            for secret in self.secrets:
                value = value.replace(secret, "[REDACTED]")
            return value
        if isinstance(value, Mapping):
            return {key: self.redact(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return tuple(self.redact(item) for item in value)
        return value

    def export(self, spans):
        sanitized = []
        for span in spans:
            events = [Event(
                name=event.name, attributes=self.redact(event.attributes), timestamp=event.timestamp,
            ) for event in span.events]
            sanitized.append(ReadableSpan(
                name=span.name, context=span.context, parent=span.parent,
                resource=span.resource, attributes=self.redact(span.attributes),
                events=events, links=span.links, kind=span.kind,
                status=Status(span.status.status_code, self.redact(span.status.description)),
                start_time=span.start_time, end_time=span.end_time,
                instrumentation_scope=span.instrumentation_scope,
            ))
        return super().export(sanitized)


class AgentTracing:
    def __init__(self, settings: Settings):
        self.public_key = settings.langfuse_public_key
        self.client = None
        if not settings.langfuse_enabled:
            return

        secrets = tuple(sorted({value for value in (
            settings.llm_api_key, settings.beidou_username, settings.beidou_password,
            settings.auth_password, settings.auth_secret, settings.amap_token,
            settings.database_uri, settings.langfuse_secret_key,
        ) if value}, key=len, reverse=True))
        base_url = settings.langfuse_base_url.rstrip("/")
        credentials = base64.b64encode(
            f"{settings.langfuse_public_key}:{settings.langfuse_secret_key}".encode()
        ).decode()
        exporter = RedactingSpanExporter(
            secrets=secrets, endpoint=f"{base_url}/api/public/otel/v1/traces",
            headers={"Authorization": f"Basic {credentials}", "x-langfuse-ingestion-version": "4"},
            timeout=5, compression=Compression.Gzip,
        )
        self.client = Langfuse(
            public_key=settings.langfuse_public_key,
            secret_key=settings.langfuse_secret_key,
            base_url=base_url,
            environment=settings.langfuse_tracing_environment,
            span_exporter=exporter,
        )

    @contextmanager
    def run(self, config: dict, *, session_id: str, run_id: str, input=None):
        run_config = {**config, "run_id": run_id}
        if self.client is None:
            yield RunTrace(run_config)
            return

        trace_id = Langfuse.create_trace_id(seed=run_id)
        with self.client.start_as_current_observation(
            name="lma-investigation", as_type="agent",
            trace_context={"trace_id": trace_id},
            metadata={"lma_run_id": run_id},
            input=input,
        ) as observation:
            with propagate_attributes(session_id=session_id, trace_name="lma-investigation"):
                run_config["callbacks"] = [
                    *config.get("callbacks", []),
                    CallbackHandler(public_key=self.public_key),
                ]
                yield RunTrace(run_config, observation)
