"""统一模型构造入口：官方 init_chat_model 按 Provider 选择 integration。

五个业务角色（主 Agent / 标题 / 推荐 / 摘要 / 视觉）只调用本工厂，各自传入独立
thinking 开关与调用参数；Provider 层把布尔思考开关显式映射为供应商官方参数，不靠
模型名猜测 Provider，也不为每个角色维护独立 Provider/Endpoint 配置。

DeepSeek 思考模式 + 多轮 tool calling 需要把上一轮 ``reasoning_content`` 原样回传，
官方 ``langchain-deepseek`` 1.1.0 读取了响应侧的 ``reasoning_content``，但构造后续
请求时不会写回（langchain #39370 / #37713），思考模式下多轮 tool calling 会返回 400。
因此 DeepSeek + thinking 开启时使用本模块的极窄请求 adapter；官方补齐后整个 adapter
删除，其余逻辑不受影响。
"""

from typing import Any

from langchain.chat_models import init_chat_model
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_deepseek import ChatDeepSeek

SUPPORTED_PROVIDERS = ("deepseek", "openai")
SUPPORTED_PROTOCOLS = ("responses", "chat_completions")
SUPPORTED_VENDORS = ("openai", "dashscope", "deepseek")


def resolve_vendor(
    provider: str,
    model: str,
    base_url: str | None = None,
    explicit_vendor: str | None = None,
) -> str:
    """识别实际底层供应商，区分模型集成 (provider)、实际供应商 (vendor) 与 API 协议 (protocol)。"""
    if explicit_vendor:
        return explicit_vendor.lower()
    url = (base_url or "").lower()
    model_name = (model or "").lower()
    if "aliyuncs.com" in url or "dashscope" in url or "qwen" in model_name:
        return "dashscope"
    if "deepseek" in url or "deepseek" in model_name or provider == "deepseek":
        return "deepseek"
    if "openai" in url or provider == "openai":
        return "openai"
    return provider.lower()


def thinking_options(
    provider: str,
    enabled: bool,
    *,
    protocol: str = "chat_completions",
    vendor: str | None = None,
) -> dict[str, Any]:
    """把布尔思考开关显式映射为供应商官方请求参数。

    区分 API 协议 (protocol) 与实际 Vendor：
    - Responses API (仅 OpenAI integration 支持)：
      - DashScope (百炼)：按百炼文档使用 reasoning.effort，开启为 "medium"，关闭为 "none"；
      - OpenAI：官方 Responses API 开启为 "medium"，关闭为 None；
    - Chat Completions API：
      - DashScope (Qwen hybrid thinking)：通过 extra_body 显式传 enable_thinking: bool；
      - DeepSeek：通过 extra_body 传 thinking.type = "enabled" / "disabled"；
      - OpenAI：普通 Chat Completions 不传额外思考参数。
    """
    if protocol not in SUPPORTED_PROTOCOLS:
        raise ValueError(
            f"unsupported protocol: {protocol!r}，当前仅支持 {SUPPORTED_PROTOCOLS}。"
        )
    if provider not in SUPPORTED_PROVIDERS:
        raise ValueError(
            f"unsupported model provider: {provider!r}，当前仅支持 {SUPPORTED_PROVIDERS}。"
        )

    v = (vendor or provider).lower()

    if protocol == "responses":
        if provider != "openai":
            raise ValueError(f"Responses API 仅适用于 openai integration，当前 provider 为 {provider!r}")
        if v == "dashscope":
            return {
                "use_responses_api": True,
                "output_version": "responses/v1",
                "reasoning": {
                    "effort": "medium" if enabled else "none",
                    "summary": "auto",
                } if enabled else {"effort": "none"},
            }
        return {
            "use_responses_api": True,
            "output_version": "responses/v1",
            "reasoning": {
                "effort": "medium",
                "summary": "auto",
            } if enabled else None,
        }

    # protocol == "chat_completions"
    if v == "dashscope":
        return {"extra_body": {"enable_thinking": enabled}}
    if v == "deepseek":
        return {"extra_body": {"thinking": {"type": "enabled" if enabled else "disabled"}}}
    return {}


def _tool_calling_capability(model: BaseChatModel) -> bool | None:
    """读取官方 profile 的 tool_calling 标记；profile 缺失时返回 None，不猜测。"""
    profile = getattr(model, "profile", None)
    if not isinstance(profile, dict):
        profile = getattr(model, "model_profile", None)
    if not isinstance(profile, dict):
        return None
    capability = profile.get("tool_calling")
    return capability if isinstance(capability, bool) else None


def model_max_input_tokens(model: BaseChatModel) -> int | None:
    """从 LangChain Model Profile 读取有效的最大输入 token 数。"""
    profile = getattr(model, "profile", None)
    if not isinstance(profile, dict):
        profile = getattr(model, "model_profile", None)
    if not isinstance(profile, dict):
        return None
    value = profile.get("max_input_tokens")
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    return None


def _fill_missing_profile(model: BaseChatModel, profile: dict[str, Any] | None) -> None:
    """仅为官方 profile 缺失的字段补值，避免覆盖已知模型能力。"""
    if profile is None:
        return
    current = getattr(model, "profile", None)
    model.profile = {
        **profile,
        **(current if isinstance(current, dict) else {}),
    }


def assert_tool_calling(model: BaseChatModel) -> None:
    """主 Agent 模型的工具能力“明确否决”：profile 标记不支持才在配置阶段失败。

    profile 缺失或未标记时不猜、不发启动探测请求、不假设能回答一次就等于支持工具调用，
    真实调用时按 Provider 返回处理。
    """
    if _tool_calling_capability(model) is False:
        name = getattr(model, "model_name", None) or getattr(model, "model", None)
        raise ValueError(
            f"模型 {name!r} 的官方 profile 标记为不支持 tool calling；主 Agent 需要工具调用"
            "能力，请更换 LLM_MODEL 或 LLM_PROVIDER。"
        )


def assert_requested_reasoning(model: BaseChatModel, enabled: bool) -> None:
    """思考开关开启时的能力明确否决：官方 profile 显式标记不支持 reasoning 时失败。

    profile 缺失或未标记时不猜、不发探测请求，由真实 Provider 请求决定。
    """
    if not enabled:
        return
    profile = getattr(model, "profile", None)
    if not isinstance(profile, dict):
        profile = getattr(model, "model_profile", None)
    if isinstance(profile, dict) and profile.get("reasoning_output") is False:
        name = getattr(model, "model_name", None) or getattr(model, "model", None)
        raise ValueError(
            f"模型 {name!r} 的官方 profile 明确不支持 reasoning；请关闭对应 THINKING 配置，"
            "或更换支持思考的模型。"
        )


class DeepSeekThinkingChatModel(ChatDeepSeek):
    """极窄 adapter：仅把上一轮 AIMessage 的 reasoning_content 写回下一轮 assistant 请求体。

    不覆写响应转换、流式分块或 usage 语义；先由官方 ChatDeepSeek 完整构造 payload，
    再按原消息顺序补回 assistant reasoning_content。官方补齐回传后整体删除。
    """

    def _get_request_payload(self, input_, *, stop=None, **kwargs: Any) -> dict:
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)
        request_messages = payload.get("messages")
        if not isinstance(request_messages, list):
            return payload

        source_messages = self._convert_input(input_).to_messages()
        for source, request_message in zip(source_messages, request_messages, strict=False):
            if not isinstance(source, AIMessage) or not isinstance(request_message, dict):
                continue
            reasoning = source.additional_kwargs.get("reasoning_content")
            if isinstance(reasoning, str) and reasoning:
                request_message["reasoning_content"] = reasoning
        return payload


def create_chat_model(
    *,
    provider: str,
    model: str,
    api_key: str,
    base_url: str | None,
    thinking: bool,
    protocol: str | None = None,
    vendor: str | None = None,
    tool_loop: bool = False,
    temperature: float | None = None,
    max_retries: int = 0,
    profile: dict[str, Any] | None = None,
    **kwargs: Any,
) -> BaseChatModel:
    """按 Provider 构造官方 integration 模型，五个业务角色共用此唯一入口。

    区分：
    - Provider (Integration): "openai", "deepseek"
    - API Protocol: "responses", "chat_completions" (默认: tool_loop 且 provider == "openai" 为 responses，其余为 chat_completions)
    - Vendor: "dashscope", "deepseek", "openai" (未显式指定时自动从 base_url 与 model 解析)
    """
    if protocol is None:
        protocol = "responses" if (tool_loop and provider == "openai") else "chat_completions"

    resolved_vendor = resolve_vendor(provider, model, base_url, vendor)
    options = thinking_options(
        provider,
        thinking,
        protocol=protocol,
        vendor=resolved_vendor,
    )

    # 视觉角色沿用 OpenAI 的 max_completion_tokens 名称；DeepSeek integration 使用
    # max_tokens。仅在统一入口做这一处确定映射，避免供应商参数散落到业务调用层。
    if provider == "deepseek" and "max_completion_tokens" in kwargs:
        if "max_tokens" in kwargs:
            raise ValueError("不能同时配置 max_completion_tokens 与 max_tokens")
        kwargs["max_tokens"] = kwargs.pop("max_completion_tokens")

    # 规范合并 extra_body
    if "extra_body" in options:
        extra_body_options = options.pop("extra_body")
        if "extra_body" in kwargs:
            kwargs["extra_body"] = {**extra_body_options, **kwargs["extra_body"]}
        else:
            kwargs["extra_body"] = extra_body_options

    if provider == "deepseek" and thinking and tool_loop:
        # DeepSeek 思考模式多轮 tool calling 需要 reasoning_content 回传，使用极窄请求 adapter。
        chat_model: BaseChatModel = DeepSeekThinkingChatModel(
            model=model,
            api_key=api_key,
            base_url=base_url,
            temperature=temperature,
            max_retries=max_retries,
            **options,
            **kwargs,
        )
    else:
        chat_model = init_chat_model(
            model=model,
            model_provider=provider,
            api_key=api_key,
            base_url=base_url,
            temperature=temperature,
            max_retries=max_retries,
            **options,
            **kwargs,
        )
    _fill_missing_profile(chat_model, profile)
    if tool_loop:
        assert_tool_calling(chat_model)
    assert_requested_reasoning(chat_model, thinking)
    return chat_model
