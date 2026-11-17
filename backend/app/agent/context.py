"""把供应商 usage 与模型 profile 投影为前端上下文用量。"""


def _token_count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def build_context_usage(usage_metadata: dict, *, max_input_tokens: int, model: str) -> dict | None:
    """仅使用供应商实际计数，模型上限来自官方 Model Profile；输入用量缺失时返回 None，由调用方保留上一快照。"""
    input_tokens = _token_count(usage_metadata.get("input_tokens"))
    if input_tokens is None:
        return None
    return {
        "input_tokens": input_tokens,
        "output_tokens": _token_count(usage_metadata.get("output_tokens")),
        "total_tokens": _token_count(usage_metadata.get("total_tokens")),
        "max_input_tokens": max_input_tokens,
        "usage_ratio": min(1.0, input_tokens / max_input_tokens),
        "model": model,
    }
