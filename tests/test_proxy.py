import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("eval_proxy", Path(__file__).parents[1] / "docker" / "proxy.py")
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)


class ReasoningGoesBack(unittest.TestCase):
    """DeepSeek reads prior steps' reasoning from `reasoning_content`; without it every step re-reasons."""

    def test_anthropic_thinking_rides_on_the_assistant_tool_call(self):
        chat = proxy.anthropic_to_chat({"model": "m", "messages": [
            {"role": "user", "content": "fix the parser"},
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "Read the parser first.", "signature": ""},
                {"type": "tool_use", "id": "t1", "name": "Read", "input": {"path": "p.py"}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "code"}]},
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "Found it."}, {"type": "text", "text": "Done."}]},
        ]})
        assistants = [m for m in chat["messages"] if m["role"] == "assistant"]
        self.assertEqual([m.get("reasoning_content") for m in assistants], ["Read the parser first.", "Found it."])
        self.assertEqual(assistants[0]["tool_calls"][0]["id"], "t1")
        self.assertNotIn("reasoning_content", chat["messages"][0])

    def test_a_thinking_only_message_hands_its_reasoning_to_the_next_assistant_message(self):
        chat = proxy.anthropic_to_chat({"model": "m", "messages": [
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "Plan."}]},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]},
        ]})
        self.assertEqual([m["role"] for m in chat["messages"]], ["user", "assistant"])
        self.assertEqual(chat["messages"][1]["reasoning_content"], "Plan.")

    def test_redacted_thinking_and_user_turns_carry_no_reasoning(self):
        chat = proxy.anthropic_to_chat({"model": "m", "messages": [
            {"role": "assistant", "content": [{"type": "redacted_thinking", "data": "x"},
                                              {"type": "text", "text": "hi"}]},
        ]})
        self.assertEqual(chat["messages"], [{"role": "assistant", "content": "hi"}])

    def test_responses_reasoning_item_rides_on_the_following_call(self):
        chat = proxy.responses_to_chat({"model": "m", "input": [
            {"type": "message", "role": "user", "content": "go"},
            {"type": "reasoning", "summary": [], "content": [{"type": "reasoning_text", "text": "Plan."}]},
            {"type": "function_call", "call_id": "c1", "name": "shell", "arguments": "{}"},
            {"type": "function_call", "call_id": "c2", "name": "shell", "arguments": "{}"},
            {"type": "function_call_output", "call_id": "c1", "output": "ok"},
        ]})
        call = chat["messages"][1]
        self.assertEqual((call["reasoning_content"], len(call["tool_calls"])), ("Plan.", 2))

    def test_streamed_reasoning_comes_back_as_a_thinking_block(self):
        answer = proxy.Answer(reasoning="Plan.", text="ok", finish_reason="stop")
        self.assertEqual(proxy.chat_to_anthropic(answer)["content"][0]["thinking"], "Plan.")


if __name__ == "__main__":
    unittest.main()
