"""LMA 主 Agent：官方 create_agent 接管 ReAct 循环与工具执行。

由自托管 API 调用工厂并注入 PostgreSQL Checkpointer。
LMA middleware 维护消息上下文和用量；官方 SummarizationMiddleware 管理历史。
"""

import logging
from uuid import uuid4
from dataclasses import replace
from functools import lru_cache, partial

from langchain.agents import AgentState as BaseAgentState, create_agent
from langchain.agents.middleware import (
    hook_config,
    AgentMiddleware,
    ModelRetryMiddleware,
    ToolRetryMiddleware,
    ToolErrorMiddleware,
    ModelCallLimitMiddleware,
    ToolCallLimitMiddleware,
)
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage

from app.beidou.client import BeidouApiError
from app.agent.tool_protocol import ToolFailure, ToolInputError, raise_tool_validation_error
from app.agent.tool_feedback import ToolFeedbackMiddleware
from app.agent.context import build_context_usage
from app.agent.evidence import EvidenceMiddleware
from app.agent.message_context import model_messages, stamp_user_message
from app.agent.summarization import create_summarization_middleware, _get_summary_model
from app.agent.prompting import SYSTEM_PROMPT
from app.agent.compute import compute
from app.agent.conclusions import CONCLUSIONS_TOOL_NAME, record_conclusions
from app.agent.retry import is_transient_error
from app.agent.models import create_chat_model, model_max_input_tokens
from app.agent.session_tools import station_history_tool
from app.agent.site import inspect_site_environment
from app.business_time import business_now
from app.agent.tools import find_stations, get_displacement
from app.agent.weather import query_weather
from app.config import get_settings

tools = [
    find_stations, get_displacement, query_weather, inspect_site_environment,
    compute, record_conclusions,
]
logger = logging.getLogger(__name__)


def _on_tool_error(exc: Exception, request) -> str | None:
    """实际执行失败转换为安全文案；参数纠错交给外层专用边界。"""
    if isinstance(exc, ToolInputError):
        return None
    if isinstance(exc, ToolFailure):
        return exc.content
    if isinstance(exc, BeidouApiError):
        logger.warning("monitoring platform rejected tool request", exc_info=True)
        return "监测平台拒绝本次查询，未取得可用数据，请检查账号访问权限或查询条件。"
    logger.warning("tool execution failed: %s", exc, exc_info=True)
    if is_transient_error(exc):
        return "数据服务暂不可用，本次查询未取得可用数据，请稍后重试。"
    return "工具执行失败，未取得可用数据，请说明这一限制。"


class AgentState(BaseAgentState):
    context_usage: dict


class QueryCallLimitMiddleware(ToolCallLimitMiddleware):
    """查询额度只约束访问外部数据源的工具。

    本地计算、计划、结论登记和读取以往结论不请求监测平台或外部服务；计入额度会让取数用尽后
    无法整理已取得的依据。它们反复调用仍受模型调用上限约束。
    """

    def _matches_tool_filter(self, tool_call) -> bool:
        return tool_call["name"] not in {"compute", CONCLUSIONS_TOOL_NAME, "get_station_history"}


_FINAL_MODEL_CALL_NOTICE = (
    "\n\n# 本轮最后一次作答\n\n"
    "本轮的调用次数即将用尽，这是最后一次作答机会，不能再调用工具。"
    "请基于已取得的证据直接用文字回答，并说明哪些对象或时段尚未覆盖。"
)


@lru_cache
def _get_llm():
    settings = get_settings()
    protocol = "responses" if settings.llm_provider == "openai" else "chat_completions"
    return create_chat_model(
        provider=settings.llm_provider,
        model=settings.llm_model,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        thinking=settings.llm_thinking,
        protocol=protocol,
        tool_loop=True,
        temperature=0,
        profile={"max_input_tokens": settings.context_model_context},
    )


class LmaMiddleware(AgentMiddleware):
    state_schema = AgentState

    def __init__(self, model, *, model_run_limit: int):
        self.model_run_limit = model_run_limit
        self.max_input_tokens = model_max_input_tokens(model)
        self.model_name = (
            getattr(model, "model_name", None)
            or getattr(model, "model", None)
            or get_settings().llm_model
        )

    async def abefore_agent(self, state, runtime):
        messages = state.get("messages", [])
        if not messages or not isinstance(messages[-1], HumanMessage):
            return None
        message = messages[-1]
        stamped = stamp_user_message(message)
        if stamped is message:
            return None
        return {"messages": [stamped]}

    @hook_config(can_jump_to=["end"])
    async def abefore_model(self, state, runtime):
        """结论登记成功且正文已随同一条回复给出时结束本轮，不再让模型复述一遍。"""
        messages = state["messages"]
        latest_results = []
        index = len(messages) - 1
        while index >= 0 and isinstance(messages[index], ToolMessage):
            latest_results.append(messages[index])
            index -= 1
        if not latest_results or any(message.status == "error" for message in latest_results):
            return None
        recorded = any(message.name == CONCLUSIONS_TOOL_NAME for message in latest_results)
        # 只登记了结论、没有写正文时回到模型补上回答；与其他查询并行发出时也需要模型继续。
        only_conclusions = all(message.name == CONCLUSIONS_TOOL_NAME for message in latest_results)
        if recorded and only_conclusions and index >= 0 and messages[index].text.strip():
            return {"jump_to": "end"}
        return None

    async def awrap_model_call(self, request, handler):
        request = request.override(messages=model_messages(request.messages))
        # 模型调用超限会让整轮报错、已取得的证据无法交付；最后一次调用撤掉工具，让模型直接作答。
        completed_model_calls = request.state.get("run_model_call_count", 0)
        if completed_model_calls >= self.model_run_limit - 1:
            final_system_message = SystemMessage(
                content=f"{request.system_message.content}{_FINAL_MODEL_CALL_NOTICE}"
            )
            request = request.override(tools=[], system_message=final_system_message)
        response = await handler(request)
        stamped = []
        for message in response.result:
            if message.type == "ai":
                metadata = {
                    **message.additional_kwargs,
                    "created_at": business_now().isoformat(timespec="seconds"),
                }
                if completed_model_calls >= self.model_run_limit - 1:
                    metadata['lma_budget_exhausted'] = True
                message = message.model_copy(update={"id": message.id or str(uuid4()), "additional_kwargs": metadata})
            stamped.append(message)
        return replace(response, result=stamped)

    @hook_config(can_jump_to=["model"])
    async def aafter_model(self, state, runtime):
        index = next(i for i in range(len(state["messages"]) - 1, -1, -1) if state["messages"][i].type == "ai")
        message = state["messages"][index]
        updates = {}
        if message.invalid_tool_calls and not message.tool_calls:
            if state.get('run_model_call_count', 0) >= self.model_run_limit:
                raise ValueError('模型在本轮预算内未能给出有效工具调用或回答')
            # 使用官方模型节点纠错并计入本轮调用预算，不解析或执行损坏的参数。
            updates['jump_to'] = 'model'
        elif not message.tool_calls and not message.text.strip():
            raise ValueError('模型未返回可用回答；已取得的证据保留')
        usage = getattr(message, "usage_metadata", None) or {}
        input_tokens = usage.get("input_tokens")
        if not (
            isinstance(input_tokens, int)
            and not isinstance(input_tokens, bool)
            and input_tokens >= 0
        ):
            logger.warning("model response did not include input token usage; preserve previous context_usage")
            return updates or None
        if self.max_input_tokens is None:
            logger.warning(
                "model profile does not include max_input_tokens; preserve previous context_usage"
            )
            return updates or None
        updates['context_usage'] = build_context_usage(
            usage,
            max_input_tokens=self.max_input_tokens,
            model=self.model_name,
        )
        return updates


def create_lma_agent(model, *, agent_tools=None, checkpointer=None, retry_delay=None, summary_model=None, storage=None):
    """生产与回归测试共用同一个官方 Agent 工厂；有存储时启用存证和以往结论查询。"""
    settings = get_settings()
    bound_tools = list(tools if agent_tools is None else agent_tools)
    if storage is not None:
        bound_tools.append(station_history_tool(storage))
    for agent_tool in bound_tools:
        agent_tool.handle_validation_error = partial(
            raise_tool_validation_error, schema_name=agent_tool.get_input_schema().__name__,
        )
    return create_agent(
        model, tools=bound_tools,
        system_prompt=SYSTEM_PROMPT,
        state_schema=AgentState, checkpointer=checkpointer,
        middleware=[
            *([EvidenceMiddleware(storage)] if storage is not None else []),
            ToolFeedbackMiddleware(),
            LmaMiddleware(model, model_run_limit=settings.agent_model_run_limit),
            create_summarization_middleware(
                _get_summary_model() if summary_model is None else summary_model,
            ),
            ModelCallLimitMiddleware(run_limit=settings.agent_model_run_limit, exit_behavior="error"),
            QueryCallLimitMiddleware(run_limit=settings.agent_tool_run_limit, exit_behavior="continue"),
            ModelRetryMiddleware(max_retries=settings.agent_max_retries, retry_on=is_transient_error,
                on_failure="error", initial_delay=settings.agent_retry_initial_delay if retry_delay is None else retry_delay,
                max_delay=settings.agent_retry_max_delay, backoff_factor=2.0, jitter=True),
            ToolErrorMiddleware(on_error=_on_tool_error),
            ToolRetryMiddleware(max_retries=settings.agent_max_retries, retry_on=is_transient_error,
                on_failure="error", initial_delay=settings.agent_retry_initial_delay if retry_delay is None else retry_delay,
                max_delay=settings.agent_retry_max_delay, backoff_factor=2.0, jitter=True),
        ],
    )
