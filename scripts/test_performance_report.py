import json
import tempfile
import unittest
from pathlib import Path

from performance_report import load_records, render


class PerformanceReportTests(unittest.TestCase):
    def test_renders_successful_model_timings_and_counts_failures(self):
        rows = [
            {"model": "deepseek / deepseek-chat", "duration": 900, "status": "ok", "at": "2026-11-04", "prompt": "private example input"},
            {"model": "deepseek / deepseek-chat", "duration": 1900, "status": "ok", "at": "2026-11-04"},
            {"model": "unknown / unreported", "duration": 350, "status": "error", "at": "2026-11-04"},
        ]
        svg, summary = render(rows)
        self.assertIn("deepseek / deepseek-chat", svg)
        self.assertIn("median 900 ms", summary)
        self.assertIn("p95 1900 ms", summary)
        self.assertIn("1 failed", summary)
        self.assertNotIn("private example input", svg.lower())

    def test_loads_browser_export_without_prompts(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "export.json"
            path.write_text(json.dumps({
                "version": 1,
                "scope": "this browser",
                "records": [
                    {"provider": "openai", "model": "gpt-4.1-mini", "durationMs": 800, "status": "ok"},
                    {"provider": "ignored", "model": "bad", "durationMs": -1, "status": "ok"},
                ],
            }), encoding="utf-8")
            rows = load_records(path)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["model"], "openai / gpt-4.1-mini")


if __name__ == "__main__":
    unittest.main()
