# Agent Note: Verify retry completion before delivering Gemini streams

Status: implemented

## Problem

Observed agy 1.4.1, 1.4.2 and 1.4.10 sessions contain a filtered response (stop_reason 11), its safety
error, and a later normal response (stop_reason 2). Its terminal result still
reports the exact earlier error. Both responses have step status DONE, so DONE
alone cannot prove success. The final response length is consistent with an
aggregate of both attempts. A stream cannot retract the first draft once sent.

The active-note audit finds two partially overlapping records:
[post-text errors](2026-10-17-gemini-post-text-errors.md) supplies the error-event
attribution warning, and [terminal lifecycle](2026-10-17-gemini-terminal-result-lifecycle.md)
supplies process/answer separation. The latter's immediate streaming and strict
terminal-error decisions are superseded; neither record is otherwise rewritten.
No proposed or rejected Gemini notes compete with this decision.

## Decision

The runner buffers every attempt and reasoning delta. The HTTP layer keeps SSE
alive through its existing heartbeat, then delivers the selected answer once.
A divergent retry therefore cannot append to a partially emitted draft.
Cancellation still terminates the CLI; stop callbacks apply at final delivery.

For the observed stale-error conflict, trajectory.js reads the exact init
conversation_id's database with node:sqlite readOnly, query_only and a read
transaction. It does not use the latest conversation, resume a session, replay
a prompt or change the database. A bounded pending-write wait is capped at 2 s.
The decoder uses published-binary protobuf descriptor observations for agy 1.4.1:
planner_response field 20, response 1, modified_response 8 and stop_reason 12;
STOP_PATTERN=2 and CONTENT_FILTER=11. Error message field 24 contains an error
in field 3, whose short_error is field 2. Descriptor observations were checked
against the original session's database, not inferred from textual DONE.

Recovery requires the filtered attempt, its matching old error, and a later DONE
normal response whose text equals this request's collected events. Conversation
ownership, payload type/status, schema version and subsequent steps are checked
at the database boundary. Later errors, unfinished steps, response tool calls,
new global failures and cancellation prevent recovery. Only the later normal
response is emitted, including when SUCCESS carries an aggregate snapshot.
Final SUCCESS already matching the last attempt needs no database exception.

The explicit compatibility set is 1.4.1, 1.4.2 and 1.4.10. Two observed 1.4.2 failures
have the same schema and filter/error/normal-response ordering. A separate safe
1.4.2 probe shows DONE emits one LF outside the persisted response. Exact event
matching accepts that one suffix only, preserves the persisted response, and
rejects additional whitespace or content differences. Removing the version
boundary or trimming arbitrary whitespace would conceal unverified changes.
Metadata-only verification traces include the detected CLI version.

Read-only observations of three 1.4.10 failing conversations establish the same
protobuf layout, complete response/error ordering, CONTENT_FILTER=11 and
STOP_PATTERN=2. They include repeated filtering and later refusal text as well
as later prose. A harmless live stream probe independently confirms ACTIVE/DONE,
the framing LF and the terminal result shape. These observations establish the
protocol, not the acceptability or success of a particular stored answer.
Recovery continues to require the current request's event text and exact old
error to match. An initial user-input step followed only by response/error steps
is required; completed tools, additional input or unknown steps prevent recovery.
Tool arguments and previously filtered drafts are never delivered as candidates.

Unsupported CLI versions, runtimes lacking the tested read-only SQLite API
(Node 22.13+ / 24+), unknown schemas and unavailable databases preserve failure.
Diagnostic reasons are metadata-only; refusal errors never carry buffered drafts.
Once the upstream terminal contract exposes reliable per-attempt stop reasons,
revisit and remove the private SQLite/protobuf compatibility path.

## Alternatives considered

- Immediate streaming preserves token latency, but OpenAI SSE cannot replace
  an earlier rejected draft when a retry produces different text.
- Trusting final ERROR exclusively preserves the documented CLI contract,
  but discards the independently observed normal second response.
- Treating any nonempty ERROR response as success keeps more text, but can
  deliver filtered, truncated or mixed attempts without evidence.
- Buffered delivery plus a narrow, versioned trajectory check handles the
  observed contradiction without hiding genuine filtering or generation failures.

## Consequences

SSE remains connected while waiting, but body text appears after validation.
Model stop strings no longer save generation time; the output filter still
applies them correctly at delivery. State verification adds at most a bounded
read/flush delay only to conflicting retry outcomes. Maintaining the private
1.4.1 protobuf schema is an explicit cost; future versions keep original failures
until verified. This does not guarantee provider availability or remove filters.

The work is in a separate development checkout. Installed TauriTavern sources,
configuration and processes are outside this change; activation is not claimed.

## Testing

Synthetic SQLite/protobuf fixtures exercise normal recovery, aggregate snapshots,
repeat filtering, unknown stop reasons, unfinished/later steps, mismatched
conversations, corrupt schemas and concurrent IDs. Read-only byte comparisons
check that verification does not modify the database. Runner tests cover final
ERROR/SUCCESS conflicts and abort during validation. A local HTTP test observes
SSE heartbeats before body delivery, then exactly one successful response.
The existing terminal-SUCCESS/hung-process regression remains covered.
A read-only check of the original session selects its later normal reply.
The file hash is unchanged. No saved chat is sent to a model for this check.

Compatibility regressions cover both supported versions, DONE framing, genuine
filtering, and future-version rejection. Real 1.4.2 session metadata and a safe
CLI probe supply the format evidence; saved prompts are not replayed.
Runtime activation and GitHub publication are separate from source validation.
