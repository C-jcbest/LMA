"""复用已有巡检与登记结论的新调查推荐；不取监测数据或写会话。"""

import asyncio
import json
import logging
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.agent.models import create_chat_model
from app.business_time import BUSINESS_TZ, business_now
from app.config import get_settings

logger = logging.getLogger(__name__)
SUGGESTION_PROMPT = (Path(__file__).with_name("prompts") / "suggestions.md").read_text(encoding="utf-8")
_GENERATION_TIMEOUT_SECONDS = 12


class SuggestedQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    station_uuid: str
    window: str
    question: Annotated[str, StringConstraints(strip_whitespace=True, min_length=4, max_length=60)]


class SuggestedQuestions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    questions: list[SuggestedQuestion] = Field(max_length=3)


@lru_cache
def _get_suggestion_llm():
    settings = get_settings()
    return create_chat_model(
        provider=settings.llm_provider,
        model=settings.llm_model,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        thinking=False,
        protocol="chat_completions",
        temperature=0.3,
        max_tokens=600,
        max_retries=0,
    )


def suggestion_context(sources: dict) -> dict:
    """只投影已保存的事实；记录时间与观测窗口分别保留。"""
    stations = []
    for row in sources["stations"]:
        windows = {}
        metrics = row["metrics"]
        for key in ("long", "recent"):
            quality = metrics.get(f"{key}_quality") or {}
            if quality.get("requested_begin") and quality.get("requested_end"):
                windows[key] = {
                    "begin_time": quality["requested_begin"],
                    "end_time": quality["requested_end"],
                    "quality": {
                        name: quality.get(name)
                        for name in ("expected", "axes", "calendar", "missing", "cleaning")
                    },
                }
        conclusions = []
        for index, conclusion in enumerate(row["conclusions"]):
            if conclusion.get("begin_time") and conclusion.get("end_time"):
                windows[f"conclusion_{index}"] = {
                    "begin_time": conclusion["begin_time"],
                    "end_time": conclusion["end_time"],
                }
            conclusions.append(conclusion)
        recorded_at = row.get("inspection_recorded_at")
        if row.get("screening") and recorded_at:
            windows["inspection_record"] = {"recorded_at": recorded_at}
        stations.append({
            "station_uuid": row["station_uuid"],
            "station_name": row["station_name"],
            "group_name": row["group_name"],
            "same_name_count": row["same_name_count"],
            "inspection_id": row.get("inspection_id"),
            "inspection_recorded_at": recorded_at,
            "screening": row["screening"],
            "reasons": [reason[:200] for reason in row["reasons"]],
            "long_window_metrics": {
                key: metrics.get(key) for key in ("net_change_mm", "slope_mm_per_day")
            },
            "cumulative_offset_mm": metrics.get("cumulative_offset_mm"),
            "windows": windows,
            "conclusions": conclusions,
        })
    return {"as_of_date": business_now().date().isoformat(), "stations": stations}


def summary_version(context: dict) -> str:
    return json.dumps(context, sort_keys=True, ensure_ascii=False, default=str)


def _date_label(value) -> str:
    if hasattr(value, "astimezone"):
        value = value.astimezone(BUSINESS_TZ).isoformat()
    return str(value)[:10]


def _json_text(text: str) -> str:
    """模型常把 JSON 包在 Markdown 代码块里；去掉围栏再解析，内容本身仍由 schema 严格校验。"""
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
        stripped = stripped.rsplit("```", 1)[0]
    return stripped.strip()


async def suggest_questions(context: dict) -> list[str]:
    if not context["stations"]:
        return ["哪些测点近期值得关注？", "近期位移变化与降雨有关吗？"]
    model = await asyncio.to_thread(_get_suggestion_llm)
    response = await model.ainvoke([
        SystemMessage(content=SUGGESTION_PROMPT),
        HumanMessage(content=json.dumps(context, ensure_ascii=False, default=str)),
    ])
    result = SuggestedQuestions.model_validate_json(_json_text(response.text))
    by_uuid = {station["station_uuid"]: station for station in context["stations"]}
    questions = []
    for item in result.questions:
        station = by_uuid.get(item.station_uuid)
        if station is None or item.window not in station["windows"]:
            continue
        window = station["windows"][item.window]
        name = station["station_name"]
        if station["group_name"]:
            name = f"{station['group_name']}·{name}"
        if station["same_name_count"] > 1:
            name = f"{name}（UUID：{item.station_uuid}）"
        if "recorded_at" in window:
            period = f"{_date_label(window['recorded_at'])}巡检记录"
        else:
            period = f"{_date_label(window['begin_time'])}至{_date_label(window['end_time'])}"
        question = f"{name}（{period}）：{item.question}"
        if question not in questions:
            questions.append(question)
    if result.questions and not questions:
        raise ValueError("推荐没有关联到有效测点和时间窗口")
    return questions


class SuggestionService:
    """单 worker 内按摘要复用；共享生成有截止时间，关闭应用时回收。"""

    def __init__(self):
        self._cache: OrderedDict[str, list[str]] = OrderedDict()
        self._pending: dict[str, asyncio.Task] = {}

    async def get(self, storage) -> list[str]:
        context = suggestion_context(await storage.suggestion_sources())
        version = summary_version(context)
        if version in self._cache:
            self._cache.move_to_end(version)
            return list(self._cache[version])
        task = self._pending.get(version)
        if task is None:
            if len(self._pending) >= 2:
                return []
            task = asyncio.create_task(self._generate(version, context))
            self._pending[version] = task
        questions = await asyncio.shield(task)
        current = suggestion_context(await storage.suggestion_sources())
        if summary_version(current) != version:
            return []
        return list(questions)

    async def _generate(self, version: str, context: dict) -> list[str]:
        try:
            async with asyncio.timeout(_GENERATION_TIMEOUT_SECONDS):
                questions = await suggest_questions(context)
            self._cache[version] = questions
            while len(self._cache) > 8:
                self._cache.popitem(last=False)
            return questions
        except Exception:
            logger.warning("question suggestion generation unavailable", exc_info=True)
            return []
        finally:
            self._pending.pop(version, None)

    async def close(self) -> None:
        tasks = list(self._pending.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._cache.clear()
