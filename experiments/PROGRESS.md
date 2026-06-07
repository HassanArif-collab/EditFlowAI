# Progress / Resume Log — Cut-Plan Optimization

> Read this first to resume. Newest entries at the bottom. All work is on
> `experiment/*` branches; `v2-simple-start` is untouched.

## How to resume in one minute
1. `git checkout experiment/cut-optimization`
2. `python -m experiments.eval` → see the scoreboard (deterministic).
3. Read the latest log entry below for what's done / what's next.
4. Backend for live testing: `python run.py --prod` (loads current code).

## Scoreboard (deterministic, fixture jawaid_66seg)
| proposer | composite | kept | cov | redun | orphan | frag | dup |
|---|---|---|---|---|---|---|---|
| baseline | -44 | 21 | 8/8 | 5 | 4 | 4 | 2 |

(LLM-on numbers live in `experiments/results/_last_llm.json`.)

## Log
### 2026-06-07 — foundation laid
- Created branch `experiment/cut-optimization` off `v2-simple-start@37c1ce6`.
- Built eval harness `experiments/eval.py` + script-anchored metrics + fixture
  `experiments/fixtures/jawaid_66seg.json` + proposer registry.
- Baseline scored (above). Harness verified working.
- **NEXT:** (a) research subagent on prior art (`glm/edl-fix-13` + papers) →
  `RESEARCH.md`; (b) implement approaches A1–A7 as proposer modules, score each;
  (c) record winners here; (d) cut integration branches for winners.

<!-- Append a new dated entry each time work advances. Keep the scoreboard current. -->
