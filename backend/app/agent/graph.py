"""LMA 主 Agent：官方 create_agent 接管 ReAct 循环与工具执行。

由自托管 API 调用工厂并注入 PostgreSQL Checkpointer。
LMA middleware 维护消息上下文和用量；官方 SummarizationMiddleware 管理历史。
"""

import logging
from dataclasses import replace
from functools import lru_cache

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
from app.agent.tool_protocol import ToolFailure, describe_validation_error
from app.agent.context import build_context_usage
from app.agent.message_context import model_messages, stamp_user_message
from app.agent.summarization import create_summarization_middleware, _get_summary_model
from app.agent.prompting import SYSTEM_PROMPT
from app.agent.report import REPORT_TOOL_NAME, submit_investigation_report
from app.agent.retry import is_transient_error
from app.agent.models import create_chat_model, model_max_input_tokens
from app.agent.site import inspect_site_environment
from app.business_time import business_now
from app.agent.tools import (
    get_daily_gnss_data,
    list_station_groups,
    list_stations,
)
from app.agent.vision import analyze_gnss_chart
from app.agent.weather import query_weather
from app.config import get_settings

tools = [list_station_groups, list_stations, get_daily_gnss_data,
         query_weather, analyze_gnss_chart, inspect_site_environment,
         submit_investigation_report]
logger = logging.getLogger(__name__)


def _on_tool_error(exc: Exception, request) -> str:
    """官方 ToolErrorMiddleware 回调：所有最终异常统一转换为受控安全文案。"""
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
    """查询额度只约束取数类工具。

    简报是提交最终回答而不是查询；若计入额度，额度用尽后已取得的证据无法以简报形式交付。
    简报反复校验失败仍受模型调用上限约束。
    """

    def _matches_tool_filter(self, tool_call) -> bool:
        return tool_call["name"] != REPORT_TOOL_NAME


_FINAL_MODEL_CALL_NOTICE = (
    "\n\n# 本轮最后一次作答\n\n"
    "本轮的调用次数即将用尽，这是最后一次作答机会，不能再发起查询或提交简报。"
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
        # 官方 return_direct 在工具失败时也会结束；简报校验失败需要回到模型修正。
        for message in reversed(state["messages"]):
            if not isinstance(message, ToolMessage):
                return None
            if message.name == REPORT_TOOL_NAME and message.status != "error":
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
                message = message.model_copy(update={"additional_kwargs": metadata})
            stamped.append(message)
        return replace(response, result=stamped)

    async def aafter_model(self, state, runtime):
        index = next(i for i in range(len(state["messages"]) - 1, -1, -1) if state["messages"][i].type == "ai")
        message = state["messages"][index]
        usage = getattr(message, "usage_metadata", None) or {}
        input_tokens = usage.get("input_tokens")
        if not (
            isinstance(input_tokens, int)
            and not isinstance(input_tokens, bool)
            and input_tokens >= 0
        ):
            logger.warning("model response did not include input token usage; preserve previous context_usage")
            return None
        if self.max_input_tokens is None:
            logger.warning(
                "model profile does not include max_input_tokens; preserve previous context_usage"
            )
            return None
        return {
            "context_usage": build_context_usage(
                usage,
                max_input_tokens=self.max_input_tokens,
                model=self.model_name,
            )
        }


def create_lma_agent(model, *, agent_tools=None, checkpointer=None, retry_delay=None, summary_model=None):
    """生产与回归测试共用同一个官方 Agent 工厂。"""
    settings = get_settings()
    bound_tools = tools if agent_tools is None else agent_tools
    for agent_tool in bound_tools:
        agent_tool.handle_validation_error = describe_validation_error
    return create_agent(
        model, tools=bound_tools,
        system_prompt=SYSTEM_PROMPT,
        state_schema=AgentState, checkpointer=checkpointer,
        middleware=[
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
