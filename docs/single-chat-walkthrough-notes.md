# Single-Chat Walkthrough Notes

> Notes from the T12 polish pass for the single-chat frontend rewrite.
> These are rough edges found during manual review — not yet fixed, to be addressed in follow-up polish.

## Known Rough Edges

1. **WS progress events not wired to progress bar**: The WebSocket receives `job_progress` events but they are only logged to console, not used to update the progress bar. Currently, polling (`_pollJobs`) drives progress updates. For faster feedback, WS events should also call `updateProgress`.

2. **Script extraction heuristic is fragile**: The heuristic `fullText.length < 3000 && !fullText.includes('\n\n\n')` to decide if a document is "clearly a script" is simplistic. A document with a few triple-newlines but still being 100% script would incorrectly trigger the LLM extraction step. Consider checking for heading patterns (`#`, `##`) or a more robust heuristic.

3. **LLM text truncation at 8000 chars**: `_extractScriptWithLLM` truncates document text to 8000 characters before sending to the LLM. If the script portion is past that cutoff, the LLM won't find it. A sliding-window or chunked approach would be more robust.

4. **Selection chip polls every 2s even when panel is hidden**: The ExtendScript poll runs continuously in `idle`/`scanned`/`source_picked` states. This could cause unnecessary overhead if the panel is open but the user is not interacting. Consider pausing when the panel loses focus.

5. **Drop overlay CSS `.drop-target-active` class is unused**: The JS toggles `hidden` on the overlay element directly. The CSS rule `.drop-target-active .drop-overlay { display: flex }` can never override `.hidden { display: none !important }`. The `drop-target-active` class is added to `<main>` but serves no visual purpose. Either remove the CSS rule or change the approach to use CSS-driven visibility.

6. **Responsive at exactly 320px**: The CSS breakpoint is at `max-width: 360px`. Between 320-360px the layout may be slightly cramped. A second breakpoint at 320px could help for very narrow panels.

7. **No loading spinner on Scan button**: When the user clicks Scan, the button is disabled but there's no visual spinner. Adding a CSS animation would improve perceived responsiveness.

8. **Bin card click vs @mention duplication**: Clicking a bin in the bin-summary-card and typing `@bin:Name` both call `onSourceProvided`, but the bin card click doesn't show a user message first. The user might not realize their click registered.

9. **No persistent backend URL across sessions**: The backend URL is stored in `localStorage.editflow_backend_url`, which works but isn't shown anywhere on first launch. If the user changes the port, they need to discover the Settings overlay.

10. **Error dismiss only returns to previous state**: The `transitionBack` function returns to `previousState`, but if the error occurred during a multi-step operation (e.g., transcription), returning to the previous state doesn't automatically retry the failed step. The user needs to click Retry explicitly.

## What Works Well

- The state machine correctly drives the 7-stage pipeline
- Bin summary cards are clear and clickable
- Autocomplete with @ mention works intuitively
- Drag-and-drop from both OS and Premiere paths are implemented
- Progress bar updates in-place (no message spam)
- Plan card with approve/regenerate is functional
- Settings and diagnostics overlays close correctly on Escape/backdrop/close-button

## Next Steps for Follow-Up

- [ ] Wire WS progress events to the progress bar
- [ ] Improve script extraction heuristic
- [ ] Add chunked LLM extraction for long documents
- [ ] Pause selection chip polling when panel loses focus
- [ ] Clean up drop overlay CSS approach
- [ ] Add 320px breakpoint
- [ ] Add spinner animation on Scan button
