# Cut-Plan Optimization — Handoff (read me first)

> Goal: turn a transcript of a retake-heavy monologue into a CLEAN final cut that
> follows the user's script — best take of each line, **comping the good parts of
> different takes**, no repeats, no false-starts, no silences.
> **Never touch `v2-simple-start`.** All work is on `experiment/*` branches.

## Branches
- `experiment/cut-optimization` — eval harness + the A1–A8 bake-off (segment-level
  approaches). See `FINDINGS.md` + `PROGRESS.md`.
- `experiment/approach-embed-dedup` — A8 integrated into real `review_service.py`
  (embedding+token dedup + coverage-preserving LLM refine). Not merged.
- **`experiment/script-aligned` (THIS branch, latest) — the real direction:**
  script-driven **phrase-level comping**. This is where active work is.

## The journey (what worked / what didn't) — full detail in FINDINGS.md
1. **Segment-level dedup/LLM (A1–A8):** A1 (embedding+token dedup) was the best
   deterministic win; A8 scored "best" on the auto-metric but **rendering exposed
   it dropped script lines** — the coarse beat-metric was Goodharted. Lesson:
   **judge by rendering + the real script, not a proxy score.**
2. **Script alignment (A5):** right frame. Deterministic embedding match is too
   weak cross-lingually (384-dim model: "10x"→"ten thousand"). LLM-as-matcher
   covers the script but kept too many takes per line.
3. **Phrase-level COMPING (`comp.py`) — current best:** the LLM returns ordered
   `{seg, verbatim-phrase}` pieces; each phrase is located in that segment's WORD
   timestamps and concatenated. It genuinely stitches take-A's opening + take-B's
   body. gemma4:31b did this well.

## Key files (on this branch)
- `experiments/comp.py` — the comping pipeline. `chat()` dispatches to Ollama or
  z.ai (`COMP_BACKEND=zai`). `locate(phrase, seg, after_cutoff=)` finds a phrase's
  time span in a segment's words; `after_cutoff=True` grabs the clean retake AFTER
  a `--`. `render_pieces(pieces, name, title)` writes a `_plan.txt` + renders a
  `_cut.mp4` via ffmpeg.
- `experiments/render_manual.py` — the **hand-corrected, user-APPROVED plan**
  (`PIECES`). This is the GROUND TRUTH to match. Run: `python -m experiments.render_manual`.
- `experiments/fixtures/jawaid_66seg.json` — the test video (segments + words + script).
- `experiments/preview/` — rendered `*_cut.mp4` (gitignored) + `*_plan.txt`.

## How to run
```
python -m experiments.render_manual          # the approved target cut → manual_cut.mp4
python -m experiments.comp                    # comp via Ollama (gemma4:31b)
COMP_BACKEND=zai python -m experiments.comp   # comp via z.ai glm-4.5-flash (FREE)
COMP_CACHE=1 python -m experiments.comp       # reuse last LLM reply (fast re-render)
```

## Models / cost (IMPORTANT)
- **Ollama cloud** (minimax/gemma4:31b/nemotron) — cost money; nemotron-3-ultra
  (550B) **times out**. gemma4:31b works well but is paid.
- **z.ai (GLM)** — key in `experiments/.zai_key` (gitignored). Account has **NO
  balance**, so paid GLM (4.6/5/5.1/air) return "Insufficient balance". **Only
  `glm-4.5-flash` is FREE and works** — use `COMP_BACKEND=zai` (defaults to it).
  CAVEAT: `glm-4.5-flash` works via `curl`, but `comp.py`'s `urllib` call hit a
  transient `SSL: UNEXPECTED_EOF` once — if it recurs, swap `zai_chat` to use
  `requests`/`httpx` (the backend ships httpx) or add a retry; it's a connection
  hiccup, not auth. Verify with: `curl https://api.z.ai/api/paas/v4/chat/completions
  -H "Authorization: Bearer $(cat experiments/.zai_key)" -d '{"model":"glm-4.5-flash","messages":[{"role":"user","content":"hi"}]}'`
- No Gemini/audio model in use (user opted out for now).

## The APPROVED target plan (match this) — manual_plan.txt, 13 pieces, 0:50
seg1(10x income) · seg10(I'm Javed/invested, trimmed at "اندر") · seg13(blew up/
10,000cr) · seg23(same loan trick) · **seg33[after `--`](2% of total income) +
seg34(tax→200cr tax-free)** · seg40(grows 10%) · seg53(opening "to my house/F-6"
only) · **seg57+58(clean take-B house body, NOT the fumbled take-A)** · seg59(250cr)
· seg62(pool/garden/basement) · seg63(seven homes→Dubai/Madina).

## Open problems / NEXT STEPS
1. **A reliable quality JUDGE is the core missing piece.** Text-only judgment
   (the agent's, and the LLM's) **cannot hear fumbles** (user's "پھینکا/پھیلا"
   house slip looked fine in text) and makes semantic stitch errors (gemma mixed
   the LOAN line with the TAX line). The only reliable judges: **(a) the user
   watching it, (b) a verification LLM pass that re-checks the assembled cut vs the
   script for wrong-stitch/missing/mid-cut, (c) eventually an audio/multimodal model.**
2. **Build the verify-and-flag pass** (highest value, no audio needed): take a comp
   plan + script → flag each piece ✅/⚠️wrong-stitch/⚠️missing/⚠️mid-cut. Would have
   caught the tax-Frankenstein and the missing tax opening automatically.
3. **Compare the z.ai/glm-4.5-flash comp output to `manual_plan.txt`** (the approved
   target) and tune the prompt until they match. ALWAYS show the user the plan
   (`*_plan.txt`) and get approval BEFORE rendering/finalizing.
4. The phrase-comp currently leaves minor seams (dangling connectors, audio jumps
   between takes). Audio-seam smoothing is a separate track.

## Working rules the user set
- ALWAYS show the cutting plan first; user approves; THEN make the video.
- Judge every plan by comparing it to the script AND the transcript, line by line.
- Don't trust auto-metrics as "good" — the user knows the content; verify against it.
