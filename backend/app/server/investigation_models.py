"""调查业务目标、结果与可追溯范围变更；执行状态不等于监测状态。"""
from datetime import datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class InvestigationTarget(BaseModel):
    model_config = ConfigDict(extra='forbid')
    target_id: str = Field(min_length=1, max_length=80)
    station_uuid: UUID
    begin_time: datetime
    end_time: datetime
    question: str = Field(min_length=1, max_length=300)
    required_kind: Literal['numerical', 'data_quality', 'weather', 'site'] = 'numerical'
    outcome: Literal['pending', 'answered', 'insufficient', 'blocked', 'withdrawn'] = 'pending'
    result: str = Field(default='', max_length=2000)
    evidence_ids: list[UUID] = Field(default_factory=list, max_length=30)

    @field_validator('begin_time', 'end_time')
    @classmethod
    def business_time(cls, value):
        if value.tzinfo is not None:
            return value.astimezone(ZoneInfo('Asia/Shanghai')).replace(tzinfo=None)
        return value

    @model_validator(mode='after')
    def valid_result(self):
        if self.begin_time >= self.end_time:
            raise ValueError('调查窗口必须正向')
        if self.outcome in {'answered', 'insufficient', 'blocked'} and (not self.evidence_ids or not self.result.strip()):
            raise ValueError('目标结果必须有实际证据及结果说明；失败和不足也需留证')
        if self.outcome == 'withdrawn' and not self.result.strip():
            raise ValueError('撤回目标必须保留原因和变更来源')
        return self


class InvestigationProgress(BaseModel):
    model_config = ConfigDict(extra='forbid')
    goal: str = Field(min_length=1, max_length=1000)
    targets: list[InvestigationTarget] = Field(min_length=1, max_length=100)
    covered: list[str] = Field(default_factory=list, max_length=100)
    unresolved: list[str] = Field(default_factory=list, max_length=100)
    stage_conclusion: str = Field(default='', max_length=3000)
    status: Literal['running', 'paused', 'completed'] = 'running'
    end_reason: str = Field(default='', max_length=500)
    scope_change_reason: str = Field(default='', max_length=500)
    changes: list[dict] = Field(default_factory=list)

    @model_validator(mode='after')
    def completion(self):
        target_ids = [target.target_id for target in self.targets]
        if len(set(target_ids)) != len(target_ids):
            raise ValueError('调查对象编号不能重复')
        answered = [target.target_id for target in self.targets if target.outcome == 'answered']
        if self.covered != answered:
            raise ValueError('已覆盖只能由目标的已回答结果派生')
        pending = [target for target in self.targets if target.outcome == 'pending']
        if self.status == 'completed' and pending:
            raise ValueError('仍有未调查对象，不能标为完成')
        if self.status == 'completed' and self.unresolved:
            raise ValueError('执行完成时将尚不能回答的问题明确记录为不足或阻塞')
        return self
