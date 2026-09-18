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


def thinking_options(provider: str, enabled: bool) -> dict[str, Any]:
    """把布尔思考开关显式映射为供应商官方请求参数。

    false 不通过“不传参数”实现：DeepSeek 思考模式默认 enabled，必须显式 disabled。
    OpenAI 标准协议没有统一的显式思考开关，开启时直接配置失败，不静默降级为普通模型。
    """
    if provider == "deepseek":
        return {"extra_body": {"thinking": {"type": "enabled" if enabled else "disabled"}}}
    if provider == "openai":
        if enabled:
            raise ValueError(
                "openai provider 不支持显式思考开关：请关闭对应 THINKING 配置，"
                f"或改用支持显式思考控制的 Provider（{SUPPORTED_PROVIDERS}）。"
            )
        return {}
    raise ValueError(
        f"unsupported model provider: {provider!r}，当前仅支持 {SUPPORTED_PROVIDERS}。"
    )


def _tool_calling_capability(model: BaseChatModel) -> bool | None:
    """读取官方 profile 的 tool_calling 标记；profile 缺失时返回 None，不猜测。"""
    profile = getattr(model, "profile", None)
    if not isinstance(profile, dict):
        profile = getattr(model, "model_profile", None)
    if not isinstance(profile, dict):
        return None
    capability = profile.get("tool_calling")
    return capability if isinstance(capability, bool) else None


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
    tool_loop: bool = False,
    temperature: float | None = None,
    max_retries: int = 0,
    **kwargs: Any,
) -> BaseChatModel:
    """按 Provider 构造官方 integration 模型，五个业务角色共用此唯一入口。

    tool_loop=True 表示该模型参与 model→tool→model 多轮调用：此时按官方 profile 做
    工具能力的“明确否决”，不支持则配置阶段失败，避免运行到 tool call 才报错。
    """
    options = thinking_options(provider, thinking)
    # 视觉角色沿用 OpenAI 的 max_completion_tokens 名称；DeepSeek integration 使用
    # max_tokens。仅在统一入口做这一处确定映射，避免供应商参数散落到业务调用层。
    if provider == "deepseek" and "max_completion_tokens" in kwargs:
        if "max_tokens" in kwargs:
            raise ValueError("不能同时配置 max_completion_tokens 与 max_tokens")
        kwargs["max_tokens"] = kwargs.pop("max_completion_tokens")
    if provider == "deepseek" and thinking:
        # DeepSeek 思考模式多轮 tool calling 需要 reasoning_content 回传，使用极窄
        # 请求 adapter；单次调用场景无历史 AIMessage，adapter 不改变其请求内容。
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
    if tool_loop:
        assert_tool_calling(chat_model)
    return chat_model
