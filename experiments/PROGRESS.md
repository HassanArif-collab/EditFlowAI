# Progress / Resume Log — Cut-Plan Optimization

> Read this first to resume. Newest entries at the bottom. All work is on
> `experiment/*` branches; `v2-simple-start` is untouched.

## How to resume in one minute
1. `git checkout experiment/cut-optimization`
2. `python -m experiments.eval` → see the scoreboard (deterministic).
3. Read the latest log entry below for what's done / what's next.
4. Backend for live testing: `python run.py --prod` (loads current code).

## Scoreboard (deterministic, fixture jawaid_66seg)
Composite = `covered_beats*10 - dup_pairs*12 - fragments*8` (higher = better).
| proposer | composite | kept | cov | frag | dup | notes |
|---|---|---|---|---|---|---|
| baseline | 24 | 21 | 8/8 | 4 | 2 | current shipped pipeline |
| a7_trim  | 24 | 20 | 8/8 | 4 | 2 | trims redundant `--` lines; safe but marginal |

Deterministic headroom is small (baseline already covers all beats). The 4
fragments that remain are *unique* false-starts (e.g. the "So…ہم--" intro) that
can't be cut deterministically without risking content — those need the LLM.
The 2 dup-pairs are SEMANTIC near-dups → target with embeddings (A1/A5).
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
