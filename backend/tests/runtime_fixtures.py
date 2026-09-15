"""无网络模型 fixture，供生产 Agent 回归测试使用。"""
from typing import Any
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field

class ScriptedModel(BaseChatModel):
    script: list[Any]
    inputs: list[Any] = Field(default_factory=list)

    @property
    def _llm_type(self):
        return "lma-architecture-test"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.inputs.append(list(messages))
        response = self.script.pop(0)
        if isinstance(response, Exception):
            raise response
        return ChatResult(generations=[ChatGeneration(message=response)])


def call(call_id="call-1"):
    return AIMessage(content="", tool_calls=[{
        "id": call_id, "name": "station", "args": {},
    }])
