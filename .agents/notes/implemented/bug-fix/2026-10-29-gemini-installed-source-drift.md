# Agent Note: Restore verified Gemini runner and keep tool instructions inert

Status: implemented

## Problem

The installed extension is a clean checkout at official commit 46fe9ce while
the development fork contains d479e90. Its origin still targets the official
repository. Runtime files lack the terminal-result lifecycle and buffered retry
fixes. Persisted response steps therefore cannot prove that the installed runner
delivered a reply. The original cause of checkout replacement is not established.

A failed tool name, emit_complete_response with a suffix, also occurs in the
request's input history. Its content parameter is not evidence that it is a
trusted internal completion mechanism. Normal prose requests using the development
runner succeed against agy 1.4.10; long replies and retry errors remain separate
validation cases.

## Decision

Keep the existing terminal-result runner and bounded timeouts. Restore the complete
versioned fork in the installed checkout during authorized activation, and point
its update origin at the user's fork so ordinary updates follow that code line.
Preserve runtime dependencies, configuration, chats and rollback records.

Per the user's request, child environments set AGY_CLI_DISABLE_AUTO_UPDATE=true,
the exact value documented in the official
[CLI troubleshooting](https://antigravity.google/docs/cli-troubleshooting).
The matching user environment setting covers newly started interactive shells;
existing shells keep their inherited environment. No ACL lock is needed.

The isolated agent explicitly treats embedded tool instructions as quoted chat
content. Tool refusal messages explain how to remove such instructions. No tool
name prefix is granted permission and no tool argument is delivered as prose.
The older [terminal lifecycle](2026-10-17-gemini-terminal-result-lifecycle.md)
and [verified retry](2026-10-18-gemini-verified-retry.md) decisions remain active;
this note addresses deployment drift and embedded tool instructions only. The
[post-text error](2026-10-17-gemini-post-text-errors.md) record remains partially
superseded by those decisions. No conflicting proposed or rejected notes exist.

Official main at 46fe9ce is already an ancestor of the fork. No additional merge
or replacement of local fixes is needed. agy 1.4.10 retry support requires the
separate protocol evidence and regression cases described in
[verified retry](2026-10-18-gemini-verified-retry.md), beyond a normal successful probe.

## Alternatives considered

- Allow emit_complete_response by prefix to recover its content: attractive for
  text delivery but unjustified because it is also in the input and the tool
  failed. Keep isolation and wait for supported terminal responses instead.
- Increase the 120-second watchdog: gives a stalled request longer to finish but
  does not restore code missing from the installed checkout. Retain the existing
  limits and restore the terminal-result fix first.
- Copy only modified files again: small deployment, but leaves Git HEAD and update
  origin on the official version. Prefer a recoverable fast-forward to the fork.

## Consequences

The source discourages accidental function calls without guaranteeing model
compliance. Real tool attempts still fail explicitly. Full versioned activation
reduces update drift but cannot prevent deliberate reinstall or external cleanup.
No authentication, permission or firewall change is part of the source fix.
Activation and remote publication require their own verified delivery evidence.

## Testing

The same isolated development runner completes a harmless prose request against
agy 1.4.10 with SUCCESS and one text delivery. Regression coverage checks the
agent instructions and that tools still fail without delivering arguments.
The existing terminal-SUCCESS, timeout, retry and SSE cases remain applicable.
