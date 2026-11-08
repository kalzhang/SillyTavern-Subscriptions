# Agent Note: Resolve Gemini post-text errors from the final outcome

Status: implemented

The final-outcome/cleanup and retry decisions are partially superseded by
[terminal-result lifecycle](2026-10-17-gemini-terminal-result-lifecycle.md).
The original error-event attribution finding and isolation boundary still apply.

## Problem

The Gemini runner kills agy whenever an `error_message` follows any response text.
That condition also rejects a completed response followed by an error event and
then a successful final result. The generated 502 does not prove that the model
stream was interrupted or that content was filtered. The observed local failure
does not identify the failed internal operation; title generation is a hypothesis.

## Decision

The runner tracks the last text-bearing `step_index`, its `DONE` state and whether
an error followed text. It waits for the final result rather than killing agy on
that error alone. Success requires a completed text-bearing step, final `SUCCESS`,
zero exit code and no structured CLI error. New text after an error, including a
reused step index, or a new active response step stops the process before duplicate
text is forwarded. A status-only completion for the original step is allowed.

Final errors and explicit safety refusals remain failures. The existing empty
refusal, tool isolation, abort and timeout paths remain in force. Metadata-only
messages distinguish a deferred error from accepted completion. No new provider,
retry policy, network call or credential handling is introduced.

## Alternatives considered

- Kill at the first post-text error: avoids replayed text immediately, but also
  prevents observing a later successful final result and produces false 502s.
- Ignore errors once text exists: preserves replies most readily, but can silently
  accept incomplete replies or concatenate a restarted answer.
- Track completion and wait for the final outcome: preserves explicitly successful
  completed replies while retaining failure and duplicate-output checks. This is
  the selected behavior.

## Consequences

An ambiguous error can now keep the request open until the existing idle/whole-turn
deadline. Same-index resumed text is treated conservatively as an ambiguous retry;
the runner does not attempt semantic deduplication. `DONE` alone is not proof of a
successful turn. This patch does not disable provider content filters or establish
that title generation caused the reported failure.

The repository has no existing notes tree. Searches of the Gemini module, tests
and docs find no competing active note; `docs/DESIGN.md` is updated with the final
contract. The local extension installation needs a proxy restart to load changes;
an upstream update may require reapplying the patch.

## Testing

The new completed-response/error/SUCCESS regression fails against the original
runner. Offline fake-CLI tests cover delayed success, repeated status-only DONE,
missing result, missing DONE, final failure, explicit refusal, structured stderr
errors, new-index and reused-index retries, and idle timeout. A local HTTP test
exercises `runGeminiChat` and `CompletionWriter` for JSON and SSE without invoking
real models or sending conversation data externally.
