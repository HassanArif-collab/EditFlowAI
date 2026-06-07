# Cut-Plan Optimization — Experiment Plan

**Goal:** improve the Review "suggest" stage (what to cut/keep) beyond the current
shipped pipeline, measured objectively, by trying several approaches and keeping
whichever scores best. **Never touch `v2-simple-start`** — all work happens on
`experiment/*` branches.

**Status:** see `PROGRESS.md` for live state + how to resume.

---

## Why an eval harness first
Cut selection is subjective; without a scorer, comparing approaches is just
eyeballing × N. The harness (`experiments/eval.py`) scores any "proposer" on a
committed fixture using **taste-light metrics anchored on the user's English
script** (the ground truth of intended content) — so it runs unattended:

| metric | meaning | want |
|---|---|---|
| `covered_beats` | of the 8 script beats, how many a kept seg delivers | 8/8 |
| `redundancy` | beats delivered by ≥2 kept segs (repetition) | 0 |
| `orphans` | kept segs matching no beat (junk/off-topic) | low |
| `fragments` | kept segs ≤2 words / with `--` / bracketed | 0 |
| `dup_pairs` | kept pairs with token-containment ≥0.6 | 0 |
| `composite` | `cov*10 − redun*12 − orphan*6 − frag*6 − dup*8` (higher=better) | ↑ |

The composite weights are arbitrary but **consistent across approaches**, so the
*relative* ranking is what matters. The 8 beats: income_10x, intro_invest,
wealth, loan_tax, growth, house, amenities, seven_homes.

**Baseline (current shipped pipeline), deterministic:** `composite=-44, kept=21,
cov=8/8, redun=5, orphan=4, frag=4, dup=2`. (LLM-on baseline recorded in results/.)

## Fixture
`experiments/fixtures/jawaid_66seg.json` — the user's real 66-segment Urdu video
+ English script. Reproducible, committed. (Add more fixtures later for robustness.)

## How to run
```
python -m experiments.eval               # all proposers, deterministic
python -m experiments.eval --llm --runs 3 # include LLM, average 3 runs (variance)
python -m experiments.eval --proposer NAME
```
Each proposer is a module in `experiments/proposers/` registered in `__init__.py`,
with signature `prop(segments, script, use_llm=False)` that sets `.decision`
in place (returns a coroutine when it does async LLM work).

## Branch strategy
- `experiment/cut-optimization` (this branch): the harness + ALL proposer modules
  (so every approach is comparable in ONE eval run) + plan + progress + research.
- `experiment/approach-<name>`: created only when an approach wins and we want it
  integrated into `backend/services/review_service.py` for real.
This keeps comparison trivial while isolating everything from `v2-simple-start`.

## Candidate approaches (the bake-off)
Each becomes a proposer module; score, compare, keep the best. Research (see
`RESEARCH.md`) may add/refine these.

1. **A1 embedding-clustering** — group retakes by multilingual sentence-embedding
   similarity instead of/with token overlap. Target: the borderline 0.55–0.60
   near-dups the token metric misses (income-growth, pool/amenities).
2. **A2 per-beat pick-one LLM** — cluster into beats, then ask the LLM to pick the
   single best take *per beat* (bounded prompt) instead of flag-the-whole-list.
   Target: LLM variance (we saw 11→28 kept) and wrong-take picks.
3. **A3 audio-feature winner** — within a beat pick the take with best delivery
   (loudness/RMS, speaking rate from word times, restart count) via ffmpeg.
   Deterministic, no LLM. Target: "best take" quality.
4. **A4 cascade** — deterministic dedup → LLM only on low-confidence/ambiguous
   beats. Target: speed + stability, fewer LLM calls.
5. **A5 script-alignment** — cross-lingual embed each script beat, keep the single
   best-matching clean take per beat. Directly optimizes coverage/non-redundancy.
6. **A6 structured/stronger LLM** — JSON-schema output, few-shot, temp 0 + seed;
   and/or a stronger model (e.g. nemotron). Target: consistency.
7. **A7 deterministic false-start trim** — cut `--` self-interrupts and leading
   `[non-speech]` asides without the LLM. Target: fragments/orphans.

## Success criteria
- An approach "wins" if it beats baseline composite on the fixture **and** reduces
  `redundancy + orphans + fragments + dup_pairs` without dropping `covered_beats`.
- Prefer deterministic/stable wins (lower variance across `--runs`).
- Record the winner; integrate into a dedicated branch; document.

## Out of scope (for now)
Audio LLM (Gemini) — separate track. Multi-clip. UI changes.
