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
| **a1_embed** | **48** | 18 | 8/8 | 4 | **0** | **WINNER (det):** embedding+token combined dedup kills both semantic near-dups, no beat lost |

**Key finding (A1):** plain embedding cosine FAILS here — distinct beats that share
vocabulary (income-10x ↔ growth = 0.677) score *higher* than the true near-dup
(growth-frag ↔ growth-full = 0.577). No single cosine threshold works. The fix is
a COMBINED gate: merge only when embedding cosine ≥0.5 AND token-containment ≥0.45.
That removed both dup-pairs (2→0) with coverage intact. Cost: ~0.5s/run after the
model is cached (first load ~40-90s downloading the 80MB MiniLM).
The remaining 4 fragments are unique false-starts → LLM territory (try A2/A6 next).

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

### 2026-06-07 — A7, A1 done (det)
- A7 (false-start trim): marginal (composite 24, unchanged). Kept for safety.
- **A1 (embedding+token dedup): WIN, composite 48** (see scoreboard + finding above).
- Research subagent hit the session limit before writing RESEARCH.md — re-run later.
- **NEXT:** (1) measure all proposers WITH `--llm` (3 runs) for final-quality + variance;
  (2) A2 = per-beat pick-one LLM (target the LLM's run-to-run variance);
  (3) if A1 holds up with LLM, integrate it into review_service.py on a branch
  `experiment/approach-embed-dedup`.

<!-- Append a new dated entry each time work advances. Keep the scoreboard current. -->
