# Cut-Plan Optimization — Findings

Autonomous bake-off of cutting approaches, scored on the real 66-segment Urdu
video against the English script (8 beats). Composite = `cov*10 − dup*12 − frag*8`.

## Final ranking (with the LLM, avg of 3 runs)
| rank | approach | composite | coverage | dups | frags | what it is |
|---|---|---|---|---|---|---|
| 🏆 1 | **a8_safe** | **66.7** | **8.0/8** | 0.0 | 1.7 | A1 dedup + coverage-preserving LLM veto |
| 2 | a1_embed | 51 | 7.0/8 | 0.0 | 2.3 | embedding+token dedup, plain LLM |
| 3 | a2_focused | 50 | 7.0/8 | 0.3 | 2.0 | LLM sees only kept segs |
| 4 | a7_trim | 42 | 7.7/8 | 1.3 | 2.3 | det. false-start trim |
| 4 | a1a2 | 42 | 5.0/8 | 0.0 | 1.0 | dedup + focused LLM (over-cuts) |
| 6 | baseline | 38 | 5.0/8 | 0.3 | 1.0 | current shipped pipeline |

(Deterministic-only: a1_embed 48 / baseline 24, both 8/8 coverage.)

## What we learned (the useful part)
1. **The LLM, not the rules, is the main quality risk.** Given all 66 segments it
   is so aggressive/inconsistent it *drops whole beats* — baseline+LLM averaged
   only **5/8** beats, with one run cutting essentially everything. Run-to-run
   variance = lost content.
2. **Plain embedding similarity does NOT dedup these takes.** Distinct beats that
   share vocabulary (income-10x ↔ growth = 0.677) outscore the true near-dup
   (growth-frag ↔ growth-full = 0.577). No cosine threshold separates them.
   **Fix:** a *combined* gate — embedding cosine ≥0.5 AND token-overlap ≥0.45.
   This (A1) removed both semantic dups with zero content loss (composite 24→48).
3. **Focusing the LLM helps; combining it with dedup hurts.** Showing the LLM only
   the kept segments lifted coverage 5.0→7.0 (A2). But dedup + focused LLM (A1A2)
   *compounded* aggressiveness and over-cut back to 5.0.
4. **The winning idea: let the LLM tighten, but VETO any cut of unique content.**
   A8 applies an LLM cut only when the segment is a fragment OR has a
   semantically-similar still-kept neighbour (genuinely redundant). Unique content
   is never cut → **8/8 coverage on every run**, dups 0, fragments trimmed.
   Composite 66.7 — nearly double the shipped baseline, and *consistent*.

## Recommendation
Ship **A8** = embedding+token dedup (A1) + coverage-preserving refine. Integration
branch: `experiment/approach-embed-dedup`. Caveats to validate before merging to
`v2-simple-start`: (a) needs `sentence-transformers` + the 80 MB MiniLM model
(first load ~40-90 s, then ~0.5 s/run, cached); (b) tested on ONE fixture — add
2-3 more clips before trusting the weights; (c) the script-anchored beat metric is
a proxy, not the user's taste — confirm a couple of outputs by eye.
