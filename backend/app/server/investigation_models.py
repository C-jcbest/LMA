"""调查业务记录；数据库是状态唯一来源，checkpoint 不复制调查状态。"""
from datetime import datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

class InvestigationTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_id: str = Field(min_length=1, max_length=80, description="调查内稳定的对象编号；同站不同问题分别编号")
    station_uuid: UUID
    begin_time: datetime
    end_time: datetime
    question: str = Field(min_length=1, max_length=300)
    evidence_ids: list[UUID] = Field(default_factory=list, max_length=30, description="已完成对象引用的持久化证据UUID")

    @field_validator("begin_time", "end_time")
    @classmethod
    def business_time(cls, value: datetime) -> datetime:
        if value.tzinfo is not None:
            return value.astimezone(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None)
        return value

    @model_validator(mode="after")
    def ordered(self):
        if self.begin_time >= self.end_time:
            raise ValueError("调查窗口必须正向")
        return self

class InvestigationProgress(BaseModel):
    model_config = ConfigDict(extra="forbid")
    goal: str = Field(min_length=1, max_length=1000)
    targets: list[InvestigationTarget] = Field(min_length=1, max_length=100)
    covered: list[str] = Field(default_factory=list, max_length=100)
    unresolved: list[str] = Field(default_factory=list, max_length=100)
    stage_conclusion: str = Field(default="", max_length=3000)
    status: Literal["running", "paused", "completed"] = "running"
    end_reason: str = Field(default="", max_length=500)
    scope_change_reason: str = Field(default="", max_length=500, description="更改对象范围、问题或已覆盖状态时解释原因")

    @model_validator(mode="after")
    def completion(self):
        target_ids = [target.target_id for target in self.targets]
        if len(set(target_ids)) != len(target_ids):
            raise ValueError("调查对象编号不能重复")
        if len(set(self.covered)) != len(self.covered) or not set(self.covered).issubset(target_ids):
            raise ValueError("已覆盖必须使用本调查对象编号，且不能重复")
        for target in self.targets:
            if target.target_id in self.covered and not target.evidence_ids:
                raise ValueError("已覆盖对象必须关联可复核证据")
        if self.status == "completed" and set(self.covered) != set(target_ids):
            raise ValueError("仍有未覆盖对象时不能标为完成")
        if self.status == "completed" and self.unresolved:
            raise ValueError("仍有待解决问题时不能标为完成")
        return self
