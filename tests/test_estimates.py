"""A model with no runs yet borrows another's cost and time per attempt, scaled by output price."""
import unittest

from eval_sandbox import config
from eval_sandbox.app import borrowed


class Borrowed(unittest.TestCase):
    def test_first_model_with_runs_scaled_by_output_price(self):
        catalog, _ = config.load(config.DEFAULT_MODELS)
        kimi = {"cost_per_attempt": 1.5, "seconds_per_attempt": 100, "by_scope": {"a/b": {"cost_per_attempt": 3.0, "seconds_per_attempt": 50}}}
        found = borrowed({"kimi-k3": kimi}, catalog)
        ratio = catalog["glm-5.3-fast"].prices["zai-org/GLM-5.3-Fast"]["output"] / catalog["kimi-k3"].prices["moonshotai/Kimi-K3"]["output"]
        self.assertAlmostEqual(found["glm-5.3-fast"]["cost_per_attempt"], 1.5 * ratio)
        self.assertAlmostEqual(found["glm-5.3-fast"]["by_scope"]["a/b"]["cost_per_attempt"], 3.0 * ratio)
        self.assertEqual(found["glm-5.3-fast"]["seconds_per_attempt"], 100)
        self.assertNotIn("deepseek-v4.1-flash-1017-fast", found)  # its own base has no runs here

    def test_own_runs_win(self):
        catalog, _ = config.load(config.DEFAULT_MODELS)
        own = {"cost_per_attempt": 0.2, "seconds_per_attempt": 30, "by_scope": {}}
        found = borrowed({"glm-5.3-fast": own, "glm-5.3": {"cost_per_attempt": 9.0, "seconds_per_attempt": 9, "by_scope": {}}}, catalog)
        self.assertIs(found["glm-5.3-fast"], own)


if __name__ == "__main__":
    unittest.main()
