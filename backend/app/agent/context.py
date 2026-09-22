"""把供应商 usage 与模型 profile 投影为前端上下文用量。"""


def _token_count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def build_context_usage(
    usage_metadata: dict,
    *,
    max_input_tokens: int,
    model: str,
) -> dict:
    """仅使用供应商实际计数；模型上限由官方 Model Profile 提供。"""
    input_tokens = _token_count(usage_metadata.get("input_tokens"))
    if input_tokens is None:
        raise ValueError("usage_metadata.input_tokens is required")
    if isinstance(max_input_tokens, bool) or max_input_tokens <= 0:
        raise ValueError("model.profile.max_input_tokens must be greater than 0")

    return {
        "input_tokens": input_tokens,
        "output_tokens": _token_count(usage_metadata.get("output_tokens")),
        "total_tokens": _token_count(usage_metadata.get("total_tokens")),
        "max_input_tokens": max_input_tokens,
        "usage_ratio": min(1.0, input_tokens / max_input_tokens),
        "model": model,
    }
