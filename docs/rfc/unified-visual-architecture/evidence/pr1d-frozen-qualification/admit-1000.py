"""Apply the frozen wall-budget admission rule to the observed 200-command run."""
import json
from pathlib import Path
import statistics
import sys

evidence = Path(sys.argv[1])
runs = {r["name"]: r for r in map(json.loads, (evidence / "runs.jsonl").read_text().splitlines())}
preflight = runs.get("history-200")
if not preflight or preflight["exitCode"] != 0:
    print(json.dumps({"admit": False, "reason": "200-command prerequisite did not pass", "preflight": preflight}))
    sys.exit(1)

rows = []
for line in (evidence / "history-200.log").read_text().splitlines():
    if line.startswith('{"event":'):
        row = json.loads(line)
        if row["event"] == "commit":
            rows.append(row["elapsedMs"])
assert len(rows) == 200
tail_median = statistics.median(rows[-25:]) / 1000
projected = preflight["durationSeconds"] + 800 * tail_median
admit = projected <= 2700 * 0.8
print(json.dumps({"admit": admit, "observedTailMedianSeconds": tail_median, "projectedSeconds": projected,
                  "budgetSeconds": 2700, "admissionLimitSeconds": 2160}))
sys.exit(0 if admit else 1)
