import unittest
from unittest.mock import AsyncMock, patch
from langchain_core.messages import AIMessage
from pydantic import ValidationError
from app.agent.suggestions import suggest_questions


class SuggestionTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_request_without_tools_and_deduplicated_questions(self):
        model = AsyncMock()
        model.ainvoke.return_value = AIMessage(content='{"questions":["近期变化如何？","近期变化如何？","降雨有何关联？"]}')
        with patch('app.agent.suggestions._get_suggestion_llm', return_value=model):
            questions = await suggest_questions({'stations': []})
        self.assertEqual(questions, ['近期变化如何？', '降雨有何关联？'])
        model.ainvoke.assert_awaited_once()
        self.assertEqual(len(model.ainvoke.call_args.args[0]), 2)

    async def test_invalid_output_is_not_presented_as_questions(self):
        model = AsyncMock()
        model.ainvoke.return_value = AIMessage(content='模型没有返回问题')
        with patch('app.agent.suggestions._get_suggestion_llm', return_value=model):
            with self.assertRaises(ValidationError):
                await suggest_questions({'stations': []})
