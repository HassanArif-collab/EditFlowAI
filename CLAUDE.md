# EditFlow AI — Claude Code Rules

## Rule 1 — Think Before Coding
State assumptions explicitly. Ask rather than guess.
Push back when a simpler approach exists. Stop when confused.

## Rule 2 — Simplicity First
Minimum code that solves the problem. Nothing speculative.
No abstractions for single-use code.

## Rule 3 — Surgical Changes
Touch only what you must. Don't improve adjacent code.
Match existing style. Don't refactor what isn't broken.

## Rule 4 — Goal-Driven Execution
Define success criteria. Loop until verified.
Strong success criteria let Claude loop independently.

## Rule 5 — Surface conflicts, don't average them
If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.
Don't blend conflicting patterns.

## Rule 6 — Read before you write
Before adding code, read exports, immediate callers, shared utilities.
If unsure why existing code is structured a certain way, ask.

## Rule 7 — Tests verify intent, not just behavior
Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

## Rule 8 — Match the codebase's conventions, even if you disagree
Conformance > taste inside the codebase.
If you think a convention is harmful, surface it. Don't fork it silently.

## Rule 9 — AE/CEP API questions: local docs first
Grep `docs/adobe/` (INDEX.md maps topics) before web-searching AE
scripting, expressions, or CEP questions. Cite the file you used.

## Rule 10 — AE code claims require bridge evidence
When the AE agent bridge is reachable (backend started with
EDITFLOW_AGENT_BRIDGE=1 — see docs/ae-agent-workflow.md), "works in AE"
claims need evidence: an ef_dumpLayers assertion and/or a rendered frame
from /api/ae-bridge/frame. When the bridge is not reachable, say
"not yet AE-verified" and point at docs/ae-captions-runbook.md.
