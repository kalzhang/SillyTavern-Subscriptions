# Agent Note: Separate Gemini terminal results from process cleanup

Status: implemented

The immediate-streaming and terminal-error decisions are partially superseded by
[verified retry delivery](2026-10-18-gemini-verified-retry.md).
The terminal-result/process-cleanup separation remains in force.

## Problem

The previous runner records result.SUCCESS but waits for child close before
settling. Its idle timer can therefore reject an already successful answer when
agy or inherited output pipes stay open. A fake CLI reproduces that false 504.
The observed user's 120 s failure log shows shutdown followed by idle timeout;
stdout was not retained, so its exact terminal-result sequence is unproven.

The active-note audit finds one partially overlapping decision:
[post-text errors](2026-10-17-gemini-post-text-errors.md).
Its immediate retry rejection and clean-exit requirements are superseded here;
its warning against attributing generic errors to title generation remains valid.
There are no other proposed or rejected Gemini notes.

## Decision

A terminal SUCCESS with an unambiguous nonempty reply settles the request without
waiting for process exit. Missing intermediate DONE does not override SUCCESS.
A terminal error remains failure and gets at most 200 ms to drain structured
stderr before mapping its status. A generic error_message, empty response, DONE,
or zero exit cannot by itself prove refusal or success.

JSON mode buffers generation until SUCCESS and emits the final response snapshot
once. Streaming mode sends ordinary initial deltas, then buffers uncertain text
after errors or response-index changes. The final snapshot must exactly extend
the already emitted prefix; only its suffix is sent. Divergent snapshots fail
with no automatic retry. An ambiguous retry without a snapshot also fails.
This handles same-step continuation without guessing whether the next text is
a retry. Explicit final safety failures remain 422.

First-output, generation-idle, final-result and whole-turn clocks are distinct.
Only response progress resets the applicable idle timer, never background stderr
or repeated status-only updates. Final settlement clears request timers. Cleanup
has a separate 2 s grace period, then kills the root process tree where available
and releases local pipe handles. Exit without close gets a 500 ms stdout drain
before reporting a missing result. This uses existing process primitives; it
does not install a supervisor or guarantee killing detached descendants whose
root has already disappeared.

Failed turns keep the existing last-failure log plus a bounded event trace of
times, event types, step indices, states, status and character counts. This trace
does not contain prompt text, reply text or credentials. Partial output is
available in error payloads as incomplete data, never as a successful choice.

## Alternatives considered

- Raw NDJSON pass-through preserves all CLI events, but Tavern expects OpenAI
  JSON/SSE and cannot consume that protocol directly.
- Waiting for clean process exit catches shutdown failures, but conflates answer
  validity with housekeeping and recreates the false-504 regression.
- Immediate rejection on resumed text prevents duplicates quickly, but cannot
  distinguish valid continuation or a later successful retry.
- Buffered final-snapshot reconciliation preserves JSON answers and compatible
  streams without semantic guessing; irreversible streamed divergence stays an
  explicit error.

## Consequences

Confirmed successful answers survive stuck cleanup. True stalls and missing
terminal results still fail within configured bounds. The plugin cannot repair
Google service failures, guarantee model availability, or bypass content filters.
Tavern may ignore the additive partial_response error field; UI recovery is not
claimed. The 2 s cleanup grace can end late housekeeping after a terminal result.

## Testing

The SUCCESS-plus-hung-process regression fails on the previous runner. Fake-CLI
tests cover inherited pipes, missing DONE, missing result, noisy logs, same-index
continuation, prefix-compatible and divergent retries, final errors, explicit
safety errors, rate limiting, isolation, stop/cancel behavior and resource cleanup.
Local HTTP tests exercise JSON/SSE completion before process exit and differing
retry snapshots; common writer tests check incomplete-error payloads.
All 56 Gemini/common tests pass on Node 24. A separate local HTTP instance using
the modified code and the real subscription CLI returns 200 and "OK" in 12.6 s
with gemini-3.8-flash-low. The live test uses no saved conversation data.
The existing port-8901 proxy still requires a restart to load the changed modules.
