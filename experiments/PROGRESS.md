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

### 2026-06-07 — +LLM measured (CRITICAL finding)
Scoreboard WITH the LLM (avg of 3 runs, fixture jawaid_66seg):
| proposer | composite | kept | coverage | dup | note |
|---|---|---|---|---|---|
| baseline+LLM | 38 | 8.3 | **5.0/8** | 0.3 | one run dropped ALL 8 beats — huge variance |
| a7+LLM | 42 | 14.7 | 7.7/8 | 1.3 | |
| a1_embed+LLM | **51** | 12.7 | 7.0/8 | 0.0 | best composite, but still drops ~1 beat |
| a2_focused+LLM | 50 | 13.3 | 7.0/8 | 0.3 | focusing LLM lifted cov 5.0→7.0 |
| a1a2+LLM | 42 | 9.0 | 5.0/8 | 0.0 | dedup+focused LLM OVER-cuts (compounds) |
| **a8_safe+LLM** | **66.7** | 14.0 | **8.0/8** | **0.0** | **OVERALL WINNER** — full coverage every run, no dups, low frag |

## 🏆 VERDICT
**A8 (`a8_safe`) wins decisively: composite 66.7 vs shipped baseline 38.**
= A1 embedding+token dedup  →  coverage-preserving LLM refine (the LLM may cut a
segment ONLY if it's a fragment or has a semantically-similar kept neighbour;
unique content is vetoed). Result: **8/8 beats kept every run** (no content loss,
the baseline's worst flaw), **0 duplicate pairs**, fragments trimmed.
Ranking (+LLM composite): a8_safe 66.7 ≫ a1_embed 51 ≈ a2_focused 50 > a7/a1a2 42 > baseline 38.

### 2026-06-07 — A8 INTEGRATED ✅
Ported A8 into real backend code on branch **`experiment/approach-embed-dedup`**
(pushed, commit 668a336): `review_service.embedding_dedup()` +
`redundant_kept_ids()` + `is_fragmentish()`, wired into `/suggest` (dedup after
classify; LLM refine is focused + coverage-preserving with the unique-content
veto). **146 unit tests pass**; embedding_dedup verified on the fixture (21→18,
3 semantic dups cut). Graceful no-op if sentence-transformers is missing.

**BEFORE MERGING `experiment/approach-embed-dedup` → `v2-simple-start`:**
1. Add 2-3 more video fixtures to `experiments/fixtures/` and re-run the eval —
   one clip is not enough to trust the thresholds (0.5 cosine / 0.45 token).
2. Eyeball 2-3 real outputs in the panel (the beat metric is a proxy, not taste).
3. Confirm `sentence-transformers` is a declared dependency for production.
4. Re-run the prior-art research (RESEARCH.md never got written — agent hit limit).
DONE for this session.

**THE core problem is the LLM**, not the deterministic layer: given all 66 segments
it is so aggressive/inconsistent it CUTS WHOLE BEATS (loses real content). baseline
+LLM averages only 5/8 beats covered. The deterministic layer is reliable (8/8).
→ **A1 deterministic-only (composite 48, guaranteed 8/8 coverage, dup 0) is arguably
SAFER than any +LLM**, because dropping a beat (lost content) is worse than keeping a
minor fragment. The promising direction: constrain the LLM so it can cut fragments/
dups but NEVER drop the last representative of a beat (coverage-preserving refine).
Measuring A2 (focused LLM on kept-only) + A1A2 now — does focusing stop beat-loss?

### 2026-06-07 — A7, A1 done (det)
- A7 (false-start trim): marginal (composite 24, unchanged). Kept for safety.
- **A1 (embedding+token dedup): WIN, composite 48** (see scoreboard + finding above).
- Research subagent hit the session limit before writing RESEARCH.md — re-run later.
- **NEXT:** (1) measure all proposers WITH `--llm` (3 runs) for final-quality + variance;
  (2) A2 = per-beat pick-one LLM (target the LLM's run-to-run variance);
  (3) if A1 holds up with LLM, integrate it into review_service.py on a branch
  `experiment/approach-embed-dedup`.

<!-- Append a new dated entry each time work advances. Keep the scoreboard current. -->

### 2026-06-07 — PHRASE-COMPING works (the real goal)
User clarified the actual requirement: don't pick a whole take — COMBINE the
well-spoken parts across takes (good opening from take A + good body from take B;
if a sentence was misspoken/cut/paused, take that part from another take).
Built `experiments/comp.py`: LLM returns ordered {seg, verbatim-phrase} pieces;
each phrase is located in that segment's WORDS (timestamps) and concatenated.
- provider_service was dead (backend down) → call Ollama directly; use **gemma4:31b**
  (much better cross-lingual comping than minimax).
- RESULT (gemma4:31b): 12 phrases, 0:44, NO repeats, and it genuinely COMPED:
  intro = seg1(10x)+seg10(I'm Javed/invest)+seg13(blew up/10000cr);
  loan = seg30(2% loan=200cr)+seg34(tax-free); one clean house take (no double).
- Refinement: trim trailing/leading '-' cut-off words at phrase edges (clean seams).
- Evidence: preview/comp_plan.txt. Video: preview/comp_cut.mp4 (gitignored, local).
- NEXT: trim dangling connectors (seg10 "جو کہ"); optional: have the LLM also avoid
  number misspeaks (14000 vs 10000 crore); audio-seam smoothing is a separate track.
