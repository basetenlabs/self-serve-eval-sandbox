"""A model with no runs yet borrows another's cost and time per attempt, scaled by output price."""
import unittest

from eval_sandbox.app import borrowed
from eval_sandbox.config import Model


def model(key: str, output: float, estimate_from: list[str] | None = None) -> Model:
    return Model(key=key, label=key, kind="open", provider="baseten", model=f"org/{key}", effort="high",
                 prices={f"org/{key}": {"input": 1.0, "output": output}}, estimate_from=estimate_from or [])


CATALOG = {m.key: m for m in [
    model("kimi", 15.0), model("glm", 4.4), model("deepseek", 1.2),
    model("new-glm", 6.6, ["glm", "kimi"]), model("new-deepseek", 2.4, ["deepseek"]),
]}


class Borrowed(unittest.TestCase):
    def test_first_model_with_runs_scaled_by_output_price(self):
        kimi = {"cost_per_attempt": 1.5, "seconds_per_attempt": 100, "by_scope": {"a/b": {"cost_per_attempt": 3.0, "seconds_per_attempt": 50}}}
        found = borrowed({"kimi": kimi}, CATALOG)
        ratio = 6.6 / 15.0
        self.assertAlmostEqual(found["new-glm"]["cost_per_attempt"], 1.5 * ratio)
        self.assertAlmostEqual(found["new-glm"]["by_scope"]["a/b"]["cost_per_attempt"], 3.0 * ratio)
        self.assertEqual(found["new-glm"]["seconds_per_attempt"], 100)
        self.assertNotIn("new-deepseek", found)  # its own base has no runs here

    def test_own_runs_win(self):
        own = {"cost_per_attempt": 0.2, "seconds_per_attempt": 30, "by_scope": {}}
        found = borrowed({"new-glm": own, "glm": {"cost_per_attempt": 9.0, "seconds_per_attempt": 9, "by_scope": {}}}, CATALOG)
        self.assertIs(found["new-glm"], own)


if __name__ == "__main__":
    unittest.main()
