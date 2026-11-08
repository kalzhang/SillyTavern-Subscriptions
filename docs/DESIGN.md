# SillyTavern-Subscriptions — design notes

This plugin fuses three earlier plugins (SillyTavern-ClaudeSubscription,
SillyTavern-CodexSubscription, SillyTavern-GeminiSubscription) into one server
plugin + one UI panel. This file records the decisions that are not obvious
from the code.

## Why one plugin

Three plugins meant three listeners (8901/8902/8903), three panels each
injecting its own `custom_include_body` block, three copies of the same SSE /
stop-sequence / folding code, and — the actual failure the user hit — two of
the server plugins were never installed while their panels were, so "Connect"
pointed at ports nobody listened on.

Now: **one listener (8901), one model list, one panel**. The provider is
inferred from the model id (`claude-*`, `gpt-*`/`o*`, `gemini-*`); the panel's
"Connect to" scope only decides which prefix the endpoint uses (`/v1`,
`/claude/v1`, `/codex/v1`, `/gemini/v1`) and therefore which models the list
shows.

## Request settings channel

SillyTavern forwards `custom_include_body` (YAML) unconditionally for Custom
sources, so the panel injects (merged into the user's own Include Body as a
structured object, with SillyTavern's bundled YAML library):

```yaml
subscriptions:
  show_reasoning: true
  claude: { backend, effort, thinking, thinking_budget, identity_mode, use_resume, fast_mode }
  codex:  { backend, effort, service_tier, reasoning_summary, verbosity }
  gemini: { backend, effort }
```

The three legacy namespaces (`claude_subscription`, `codex_subscription`,
`gemini_subscription`) are still parsed so an old panel keeps working during
migration. Precedence: unified namespace > legacy namespace > OpenAI
`reasoning_effort` / `verbosity`. Fast mode (it draws Extra Usage) is read only
from the namespaces, never from a generic top-level field.

Requests sent through Connection Manager profiles never fire
`CHAT_COMPLETION_SETTINGS_READY`, so they arrive without the block and get the
server defaults. There is deliberately no server-side "default settings"
store: it would apply billing choices to every client of the listener.

## Reading the message list

`partitionConversation()` (lib/common/messages.js) is the single reading all
three providers share:

* only the **leading** run of system messages is the system prompt;
* later system messages (Author's Note / World Info at depth, Impersonate,
  quiet prompts, group nudges, post-history instructions) become user turns
  **in place**, adjacent user turns merged — the same conversion
  SillyTavern's own Claude converter does;
* a reply is a continuation/prefill **only** when the literal last message is
  an assistant message. The continued message stays in the history (the
  model sees its own words as its turn), followed by the plain
  "[Continue your last message…]" instruction.

## Backends per provider

| Provider | `subscription` | `api` | `auto` |
| --- | --- | --- | --- |
| Claude | Agent SDK with the Claude login, account-isolated (below) | SDK with `ANTHROPIC_BASE_URL` + key/token and `CLAUDE_CONFIG_DIR` pointed at an empty plugin dir so the OAuth login is invisible | the subscription first; a quota-exhausted reply (or a rate limit that outlasts the retries) retries the same request on the API key when one exists. A key existing, or a login the plugin cannot see, never switches billing. |
| Codex | app-server, `modelProvider: "openai"`, only for a ChatGPT login (`account/read` type `chatgpt`); an API-key login is refused | direct OpenAI-compatible HTTP when a key exists (clean `messages[]`), else app-server with the non-OpenAI provider from `config.toml` | app-server exactly as the CLI is configured (so a provider switch made in the CLI is honoured); direct HTTP when no CLI but a key |
| Gemini | `agy` print mode on the Google sign-in; refused when agy's settings route it to an API key / relay | direct HTTP with the key to its paired base URL (default: Google's OpenAI-compatible endpoint) | agy as configured, else key |

Default backend is `subscription` for every provider — this is a subscription
plugin, so a key is only ever billed after the user opts in (Auto or API).

## Claude specifics

* **Agent SDK ≥ 0.3.285** (bundled Claude Code 2.1.285). The CLI version
  decides model support: Opus 5.5 needs 2.1.280+, Sonnet 5.5 2.1.284+, Fable
  2.1.251+. `/status` reports the CLI version next to the SDK version.
* The catalog mirrors the CLI's baked model table: context window (native 1M
  vs a `[1m]` beta variant), thinking family (always / adaptive / hybrid /
  budget) and effort levels. The CLI does the final request shaping (it drops
  `disabled` on always-thinking models, turns adaptive into a budget on old
  models, lowers unsupported effort levels); the plugin mirrors it to log
  honestly and to avoid 400s. `[1m]` on a native-1M model resolves to the
  plain model; on Opus/Sonnet 4.6 it uses the tier alias + env pin.
* **Isolation recipe** (everything verified by capturing the exact request
  body against a local server):
  * options: custom `systemPrompt` (`snapshot: false`), `tools: []`,
    `skills: []`, `settingSources: []`, `mcpServers: {}` + `strictMcpConfig`,
    `verbatimPrompts` (no `@file` expansion, no slash commands, no turn-start
    attachments), `permissionMode: 'dontAsk'` (bypass mode exits as root),
    a fixed `title` (no title-generation side call), `persistSession: false`
    on the non-resume paths;
  * env (lib/claude/env.js): every `ANTHROPIC_*` / `CLAUDE_CODE_*` / `OTEL_*`
    and thinking/caching/compaction override scrubbed; attachments, git
    instructions, the token-count reminder, terminal titles, auto-compaction
    and claude.ai MCP connectors off;
  * account: with a full login the CLI injects the account email — from its
    account record, and when that is missing it fetches the profile itself
    (verified live: redirecting only `CLAUDE_CONFIG_DIR`, with
    `CLAUDE_SECURESTORAGE_CONFIG_DIR` pointing back at the real login, still
    leaked it). With a bare token in `CLAUDE_CODE_OAUTH_TOKEN` it has no
    profile. So the subprocess gets empty plugin-owned config and
    secure-storage dirs plus the login's access token (read from the
    credentials file or the macOS Keychain item — named exactly as the CLI
    names it — and refreshed by the plugin; the CLI cannot refresh an env
    token). No usable token → an actionable 401, never a silent fallback;
    `ST_SUBSCRIPTIONS_CLAUDE_ISOLATE_ACCOUNT=0` is the explicit opt-out.
  * billing guard: the CLI resolves credentials itself (a /login-managed
    Console key or an `ant` profile can outrank the claude.ai login). Every
    path streams its prompt, held behind a gate until
    `initializationResult()` shows `apiKeySource` none/oauth and a
    first-party provider; otherwise the query is aborted before anything is
    sent.
  * what remains: the mandatory billing header + one-line agent identity
    (subscription auth requires it) and a short environment note (working
    directory, git flag, platform, shell, OS, model name, date). The only
    switch for the latter
    (`CLAUDE_CODE_SIMPLE`) also disables OAuth.
* **Working directory matters to the safety classifier.** The environment
  note shows the working directory. With the drive root or a nondescript
  folder, Opus 5.5's classifier refused plain roleplay lines as "cyber"
  (deterministically); from a folder named like a chat app it answered. The
  subprocess runs in `<plugin>/.runtime/SillyTavern-chat` (nothing is written
  there). A cwd inside the Claude desktop app's virtualised AppData also
  fails to spawn (`ENOTCONN`).
* **No model substitution, ever.** The CLI's refusal fallback (e.g. Opus 5.5 →
  Opus 5 / 4.8), same-model refusal retry, model-access fallback and legacy
  remap are switched off by env. Refusals are detected structurally
  (`model_refusal_no_fallback`, `stop_reason: "refusal"`) and are final. The
  served-model guard (init, every `message_start`, every assistant message)
  compares canonical ids for every model, as a backstop.
* Thinking budgets: the CLI raises a budget below 1024 to 1024 even when
  `max_tokens` is smaller, and the API accepts that with interleaved
  thinking (verified live on Haiku 4.5), so 3.0's "no thinking under 2048
  max tokens" guard is gone.
* **Max response length.** When a reply hits `max_tokens` the CLI injects
  hidden "resume" turns up to three times. The plugin aborts at the first
  `message_delta` with `stop_reason: "max_tokens"` and finishes with
  `finish_reason: "length"`. Partial messages are always on internally; text
  is forwarded only from `text` blocks.
* The CLI reports locally generated errors as an assistant message with
  `model: "<synthetic>"`; its text *is* the error.
* Synthetic session resume (`resume` + one-shot `SessionStore`) gives real
  multi-turn context and prompt caching. The SDK materialises the history in
  its own temp config dir and deletes it when the subprocess exits.
* Error classifiers match HTTP status codes only as status codes ("API
  Error: 429", "(429)") — bare digits appear in token counts, message indexes
  and request ids.

## Codex specifics

* `codex exec --json` gives no token streaming; `codex app-server` (JSON-RPC
  over stdio) streams `item/agentMessage/delta`, reasoning summaries, token
  usage and rate limits, accepts `baseInstructions` (replacing the coding
  system prompt), `ephemeral: true` threads, and `turn/interrupt` (used for
  stop sequences and client disconnects). One process is kept alive; threads
  are released with `thread/unsubscribe` (ephemeral threads cannot be deleted).
* Isolation uses `-c` overrides only (an unknown key never breaks startup):
  the agent features (shell, patch, web search, MCP resources, multi-agent…)
  off, the environment/permissions/apps/collaboration/skills prompt blocks
  off, `project_doc_max_bytes=0`, `developerInstructions: ''`, read-only
  sandbox, approval policy `never`, every approval request refused, and any
  tool item that still starts ends the turn as an error. Codex still declares
  `apply_patch` and `request_user_input` (attached per model family, no
  switch); the sandbox, the fileChange guard and the auto-answered input
  request neutralise them. On "Subscription only" an `openai_base_url` /
  `chatgpt_base_url` pointing at a non-OpenAI host is refused (it would carry
  the ChatGPT token). After `initialize`
  the effective config (`config/read`) is checked; an MCP server that is
  still enabled means one relaunch with it off, then fail closed.
* The global `AGENTS.md` in the Codex home is always injected and has no
  switch; `thread/start` reports it in `instructionSources`, and a non-empty
  one refuses the chat before any model call.
* `model/rerouted` and cyber/misalignment policy errors are hard errors; a
  `thread/start` that reports a different model is refused. `ultra` effort is
  sent as `max` (or `xhigh`) — `ultra` switches Codex to multi-agent mode.
* Model catalog is live (`model/list`), then `models_cache.json`, then a static
  snapshot. Efforts are clamped to what the model supports.

## Gemini specifics

* Prompt on **stdin** with `--input-format text` (no `-p`): avoids the
  command-line length limit on long chats.
* Every turn runs a plugin-owned workspace agent
  (`.runtime/gemini-cwd/.agents/agents/st-subscriptions-chat/agent.md`:
  `inheritCustomizations: false`, `inheritMcp: false`,
  `excludeDefaultComponents: true`, `tools: []`) with `--sandbox` and
  `--disable-slash-commands`. agy silently falls back to its default agent for
  an unknown `--agent`, so each run writes its own log and the turn is killed
  if the log shows the fallback. Any tool step kills the process tree.
* agy can retry a failed/blocked prompt internally (no switch for that in
  1.2.14). An empty response plus an intermediate error does not establish
  a refusal. Explicit final safety errors map to 422; the plugin adds no
  provider retry or fallback. Use the API backend when strict wire-level
  no-retry matters. Persistent 429s
  end the turn after ~11 s instead of waiting for the watchdog. agy also adds
  the host's local time to each turn.
* agy never streams thoughts in stream-json mode; reasoning display only
  works on the `api` backend. Images are not supported on the agy path.
* A terminal `result.SUCCESS` with a nonempty, unambiguous response completes
  the request immediately. A preceding `DONE` or clean process exit is not
  required; cleanup receives a separate 2 s grace period and cannot change the
  completed HTTP result. Late shutdown errors are not generation failures.
  Final errors allow a bounded 200 ms stderr drain for status mapping.
* The agy runner buffers both text and reasoning for JSON and SSE. SSE opens with
  the existing heartbeat, but emits its body only after terminal validation.
  This intentionally trades immediate token display for a single coherent reply:
  a restarted answer can replace a buffered draft before any content is sent.
  Stop strings are applied at delivery, so they no longer stop model generation
  early. Aborts and timeouts still cancel generation.
* agy 1.4.1/1.4.2/1.4.10 can report an earlier CONTENT_FILTER error after a later normally
  stopped response. On this conflict, `lib/gemini/trajectory.js` checks only the
  exact conversation's SQLite file in read-only mode. Recovery requires the old
  error to match, a later DONE response with STOP_PATTERN, matching event text,
  and no later error/unfinished step, response tool calls or new global error.
  Event text may have one extra framing LF emitted with DONE; other differences
  are rejected, and delivery uses the persisted normal response.
  Only the verified retry text is delivered; filtered drafts and aggregate
  `result.response` snapshots are never used for recovery.
* Recovery uses dynamically imported `node:sqlite` on Node 22.13+ / 24+,
  an exact tested CLI version (1.4.1, 1.4.2 or 1.4.10), and a bounded 1.5 s read/flush wait
  (`ST_SUBSCRIPTIONS_AGY_RETRY_CHECK_MS`, capped at 2 s). Older runtimes,
  unknown CLI versions, missing/mismatched databases and undecodable schemas
  preserve the error. A SUCCESS snapshot mixing attempts also requires this
  verification; a snapshot that exactly matches the last attempt is unambiguous.
  The same-index/no-snapshot ambiguity remains an error.
* Waits remain bounded: first text 240 s, generation idle 120 s, response-DONE to
  terminal result 120 s, whole turn 600 s. The corresponding env overrides are
  `ST_SUBSCRIPTIONS_AGY_FIRST_OUTPUT_MS`, `ST_SUBSCRIPTIONS_AGY_IDLE_MS`,
  `ST_SUBSCRIPTIONS_AGY_FINAL_RESULT_MS` and `ST_SUBSCRIPTIONS_AGY_TIMEOUT_MS`;
  cleanup uses `ST_SUBSCRIPTIONS_AGY_CLEANUP_MS`. Stderr and repeated status-only
  updates never reset progress timers. `DONE` or a zero exit without a terminal
  result is not success. Failure logs include a bounded metadata-only event trace.
  Non-refusal errors with partial text expose
  `partial_response: {content, incomplete: true}` in JSON/SSE error payloads;
  existing Tavern UIs may only display the error. Refusal errors do not expose
  unverified drafts.

## HTTP layer

* Cancellation: one AbortController per chat request, aborted on the
  response's `close` before it finished (never `req` 'close', which fires as
  soon as the body is read on Node ≥ 16) and on plugin shutdown. Runners get
  its signal (lib/common/abort.js).
* Streaming responses start at once with an SSE keep-alive comment every
  15 s, so proxies with first-byte timeouts survive long silent thinking.
  Early errors then arrive as an SSE error event (SillyTavern shows it as a
  toast).
* Access: loopback Host allowlist (DNS rebinding); a non-loopback bind needs
  `ST_SUBSCRIPTIONS_TOKEN`. Model ids are validated before routing.

## Platform

* Nothing is ever spawned through a shell. Windows `.cmd` shims are resolved
  to the npm JS launcher they wrap and run with the current Node; a shim that
  cannot be resolved is refused. Resolution prefers `.exe`, then the
  package's JS launcher under the global `node_modules`, then native-installer
  paths, then PATH. Termux adds `$PREFIX/bin` and `$PREFIX/lib/node_modules`.
* Claude Code has no Android build; on Termux a binary is accepted only after
  `--version` actually runs. The supported route is proot-distro.
