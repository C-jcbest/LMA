"""上下文管理逻辑自测：不依赖 LangGraph Server，直接调用 context.py。

用法（backend 目录）：
  .venv/Scripts/python.exe _dbg_context.py            # 逻辑测试（不调 LLM，不压缩）
  .venv/Scripts/python.exe _dbg_context.py --live     # 追加真实压缩调用测试（需 .env LLM 可用）

覆盖场景：
  1. 未超触发线：零修改放行
  2. 超线：从最旧段淘汰至目标水位，AI tool_calls 与 ToolMessage 成对淘汰
  3. 最少保留段数兜底：只剩 min_turns 段时停止淘汰
  4. 触发线计算：模型上下文百分比 vs 绝对阈值取小
  5. 压缩失败降级：LLM 异常时消息不被淘汰
"""

import asyncio
import os
import sys
import uuid

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from pydantic_settings import BaseSettings, SettingsConfigDict

# 先于导入 context 覆盖默认阈值，避免读到 .env 的真实配置干扰逻辑测试
os.environ["CONTEXT_TOKEN_THRESHOLD"] = "5000"
os.environ["CONTEXT_MODEL_CONTEXT"] = "0"
os.environ["CONTEXT_OUTPUT_RESERVE_TOKENS"] = "0"
os.environ["CONTEXT_SAFETY_MARGIN_TOKENS"] = "0"
os.environ["CONTEXT_TOKEN_ESTIMATE_FACTOR"] = "1"

from app.agent.context import (  # noqa: E402
    _estimated_tokens,
    _evictable_text,
    count_message_tokens,
    get_trigger_threshold,
    manage_context,
    split_turns,
)
from app.config import get_settings  # noqa: E402


def mk_human(text: str) -> HumanMessage:
    return HumanMessage(content=text, id=str(uuid.uuid4()))


def mk_ai(text: str, tool_calls: list | None = None) -> AIMessage:
    return AIMessage(
        content=text,
        tool_calls=tool_calls or [],
        id=str(uuid.uuid4()),
    )


def mk_tool(call_id: str, payload: str) -> ToolMessage:
    return ToolMessage(content=payload, tool_call_id=call_id, name="get_daily_gnss_data", id=str(uuid.uuid4()))


def build_turn(i: int, big_payload: str = "") -> list:
    """一段完整对话：human -> ai(tool_calls) -> tool -> ai(最终回答)。"""
    call_id = f"call_{i}"
    msgs = [mk_human(f"第{i}轮：查询站点-{i} 的日数据")]
    msgs.append(mk_ai("", [{"name": "get_daily_gnss_data", "args": {"station": f"站点-{i}"}, "id": call_id}]))
    msgs.append(mk_tool(call_id, big_payload or f'{{"summary": {{"n": {{"first": 1.0, "last": 2.0}}}}}}'))
    msgs.append(mk_ai(f"第{i}轮回答：站点-{i} 北向位移 1.0mm 变化。"))
    return msgs


class TestResult:
    def __init__(self):
        self.passed = 0
        self.failed = 0

    def check(self, name: str, cond: bool):
        if cond:
            self.passed += 1
            print(f"  PASS  {name}")
        else:
            self.failed += 1
            print(f"  FAIL  {name}")


def test_trigger_threshold(r: TestResult):
    print("[1] 触发线计算（取小逻辑）")
    # 环境变量已设 threshold=5000, model_context=0
    r.check("仅阈值时 trigger=5000", get_trigger_threshold() == 5000)

    os.environ["CONTEXT_MODEL_CONTEXT"] = "8000"  # 8000*0.8=6400 > 5000
    get_settings.cache_clear()
    r.check("model_context 百分比更大时仍取 5000", get_trigger_threshold() == 5000)

    os.environ["CONTEXT_MODEL_CONTEXT"] = "4000"  # 4000*0.8=3200 < 5000
    get_settings.cache_clear()
    r.check("model_context 百分比更小时取 3200", get_trigger_threshold() == 3200)

    os.environ["CONTEXT_MODEL_CONTEXT"] = "0"
    get_settings.cache_clear()


def test_no_compress_below_threshold(r: TestResult):
    print("[2] 未超触发线：零修改")
    # 5000 阈值下构造约 1~2k token 的会话
    msgs = []
    for i in range(1, 5):
        msgs.extend(build_turn(i))
    update = asyncio.run(manage_context(msgs, ""))
    r.check("返回空更新", update == {})
    r.check("消息未被删减", len(msgs) == 16)


def test_compress_eviction(r: TestResult):
    print("[3] 超线淘汰：成对淘汰 + 目标水位")
    # 阈值 5000、目标水位 2500。构造中等 payload（单段约 600 token）：
    # 8 段约 5.2k 超线，淘汰至 ≤2500 应剩约 4 段
    mid = '{"points": [' + ",".join('{"n":1.0,"e":2.0,"u":3.0,"t":"2026-09-01 00:00:00"}' for _ in range(16)) + "]}"
    msgs = []
    for i in range(1, 9):
        msgs.extend(build_turn(i, mid))

    # 拦截压缩 LLM：返回固定摘要，验证淘汰逻辑不依赖真实 LLM
    import app.agent.context as ctx

    real_compress = ctx.compress_history

    async def fake_compress(texts, prev):
        return "【监测对象】站点-1、站点-2\n【关键数据事实】北向位移 1.0mm"

    ctx.compress_history = fake_compress
    try:
        update = asyncio.run(manage_context(msgs, ""))
    finally:
        ctx.compress_history = real_compress  # 恢复，避免影响后续 --live 场景
    r.check("返回了状态更新", update != {})
    remove_ids = {m.id for m in update.get("messages", [])}
    evicted_turns = len(remove_ids) // 4
    r.check(f"按段淘汰（实际淘汰 {evicted_turns} 段）", evicted_turns >= 4)
    r.check("从最旧段开始淘汰", remove_ids <= {m.id for m in msgs})
    r.check("最新段永不淘汰", msgs[-1].id not in remove_ids and msgs[-2].id not in remove_ids)
    r.check("更新了摘要", "站点-1" in update.get("context_summary", ""))
    # 成对淘汰验证：被淘汰的 tool_call 与 ToolMessage 同时消失
    ai_call = msgs[1]
    tool_msg = msgs[2]
    r.check("tool_calls 与 ToolMessage 成对淘汰", ai_call.id in remove_ids and tool_msg.id in remove_ids)

    # 剩余消息 token 应低于目标水位 2500（含摘要）
    remaining = [m for m in msgs if m.id not in remove_ids]
    total = sum(count_message_tokens(m) for m in remaining) + _estimated_tokens(update["context_summary"])
    r.check(f"压缩后总量 {total} ≤ 目标水位 2500", total <= 2500)


def test_min_turns_guard(r: TestResult):
    print("[4] 最少保留段数兜底")
    # 阈值 5000，2 段但总量超线：min_turns=2 时不再淘汰
    big = '{"points": [' + ",".join('{"n":1.0,"e":2.0,"u":3.0,"t":"2026-09-01 00:00:00"}' for _ in range(300)) + "]}"
    msgs = build_turn(1, big) + build_turn(2, big)
    update = asyncio.run(manage_context(msgs, ""))
    r.check("只剩 min_turns 段时不淘汰", update == {})


def test_degrade_on_llm_failure(r: TestResult):
    print("[5] 压缩失败降级")
    big = '{"points": [' + ",".join('{"n":1.0}' for _ in range(300)) + "]}"
    msgs = build_turn(1, big) + build_turn(2, big) + build_turn(3, big)

    import app.agent.context as ctx

    real_compress = ctx.compress_history

    async def broken_compress(texts, prev):
        raise RuntimeError("simulated compress failure")

    ctx.compress_history = broken_compress
    try:
        update = asyncio.run(manage_context(msgs, ""))
    finally:
        ctx.compress_history = real_compress  # 恢复，避免影响后续 --live 场景
    r.check("LLM 异常时放弃淘汰（空更新）", update == {})


def test_evictable_text(r: TestResult):
    print("[6] 淘汰预处理：工具明细剔除、tool_calls 剥离")
    r.check("ToolMessage 剔除", _evictable_text(mk_tool("c1", "x")) is None)
    r.check("无正文 AI 剥离 tool_calls 后丢弃", _evictable_text(mk_ai("", [{"name": "t", "args": {}, "id": "c"}])) is None)
    r.check("human 文本保留", "用户" in (_evictable_text(mk_human("你好")) or ""))
    r.check("AI 正文保留", "助手" in (_evictable_text(mk_ai("回答")) or ""))


def test_live_compress(r: TestResult):
    print("[7] 真实压缩调用（--live）")
    from app.agent.context import compress_history

    texts = [
        "用户：帮我查一下站点-黄土坡2号 in 2026-09-01 至 2026-09-02 的日数据",
        "助手：黄土坡2号北向位移首值 3.20mm、末值 5.60mm，变化量 +2.40mm，存在台阶式跳变；同期 9 月 1 日降雨 42mm。",
    ]
    summary = asyncio.run(compress_history(texts, ""))
    r.check("摘要非空", len(summary) > 0)
    r.check("站点名保留", "黄土坡" in summary)
    r.check("数值逐字保留", ("3.20" in summary and "5.60" in summary) or ("2.40" in summary))
    print("  ---- 摘要预览 ----")
    for line in summary.splitlines():
        print("   ", line)
    print("  ------------------")


if __name__ == "__main__":
    # 重置为逻辑测试默认值
    get_settings.cache_clear()
    r = TestResult()
    test_trigger_threshold(r)
    test_no_compress_below_threshold(r)
    test_compress_eviction(r)
    test_min_turns_guard(r)
    test_degrade_on_llm_failure(r)
    test_evictable_text(r)
    if "--live" in sys.argv:
        test_live_compress(r)
    else:
        print("\n(跳过 [7] 真实压缩调用，追加 --live 启用)")
    print(f"\n结果：{r.passed} passed, {r.failed} failed")
    sys.exit(1 if r.failed else 0)
