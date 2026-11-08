// ──────────────────────────────────────────────
// Subscriptions — UI extension for the `subscriptions` server plugin
// ──────────────────────────────────────────────
//
// This file is the UI EXTENSION (loaded in the browser). The SERVER plugin
// entry is plugin.js. Keeping the extension at the repo root with manifest.json
// makes the repo installable straight from SillyTavern's "Install extension"
// dialog, AND the server plugin auto-installs these same files. When two
// copies load, a window guard keeps exactly one active: a newer copy takes
// over from an older one, and a warning names both folders.
//
// SillyTavern loads extension scripts as ES modules (type="module"), so the
// pure helpers below are exported for the unit tests (test/ui.test.js). The
// browser boot only runs when SillyTavern's global API is present. Everything
// is built on SillyTavern.getContext() / SillyTavern.libs — no relative
// imports — so the file works unchanged from ANY install location.
//
// What it does:
//   • One-click Connect: points SillyTavern's Custom (OpenAI-compatible)
//     source at the plugin's local endpoint and connects exactly once. It
//     never touches the Custom API key field (Custom is keyless in ST, and
//     the api/auto backends read a real key from there). A "scope" picker
//     chooses whether the model list shows every subscription or just one.
//   • Per-provider settings (Claude effort/thinking/identity/resume/fast mode,
//     Codex effort/service tier/reasoning summary/verbosity, Gemini effort,
//     and a subscription / auto / API backend switch for each) injected per
//     request as a `subscriptions` object merged into `custom_include_body`.
//     The merge is structural (SillyTavern's own YAML parser), so JSON, flow,
//     list and commented Include Body texts keep working; plain text is only
//     the fallback when the parser is missing or the text does not parse.
//   • Status & quota panel with per-backend readiness badges: same-origin
//     plugin route first (works from remote browsers), direct listener
//     fallback. Shallow check on first open, deep check on the refresh button.
//
// Injection only fires when the active connection points at this plugin's
// listener, so other Custom endpoints are untouched. The defaults are
// subscription-only for every provider; nothing here ever enables key billing.

export const UI_VERSION = '3.1.0';
export const SETTINGS_VERSION = 3;
export const DEFAULT_BASE = 'http://127.0.0.1:8901';

const MODULE = 'subscriptions';
const PLUGIN_ROUTE = '/api/plugins/subscriptions';
const TAG = '[subscriptions]';
const SELF_URL = import.meta.url;

export const PROVIDER_KEYS = ['claude', 'codex', 'gemini'];
export const SCOPES = ['all', 'claude', 'codex', 'gemini'];
export const BACKENDS = ['subscription', 'auto', 'api'];
export const CLAUDE_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
export const CLAUDE_THINKING = ['adaptive', 'on', 'off'];
// 'ultra' is gone from the picker: for roleplay it is the same as max (the
// server maps it down). Saved 'ultra' values migrate to 'max'.
export const CODEX_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
export const CODEX_TIERS = ['standard', 'priority', 'ultrafast'];
export const CODEX_SUMMARIES = ['auto', 'concise', 'detailed', 'none'];
export const CODEX_VERBOSITY = ['default', 'low', 'medium', 'high'];
export const GEMINI_EFFORTS = ['auto', 'low', 'medium', 'high'];
export const DEFAULT_GEMINI_FALLBACK_INSTRUCTION = "Follow the user's instructions.";

// One-time panel notices (dismissible, persisted until dismissed).
export const NOTICE_IDS = ['customKeyPlaceholder', 'fastModeCost'];

export const defaultSettings = {
    enabled: true,
    endpointBase: DEFAULT_BASE,
    scope: 'all',
    showReasoning: true,
    claude: { backend: 'subscription', effort: 'auto', thinking: 'adaptive', identityMode: false, useResume: true, fastMode: false },
    codex: { backend: 'subscription', effort: 'auto', serviceTier: 'standard', reasoningSummary: 'auto', verbosity: 'default' },
    gemini: {
        backend: 'subscription',
        effort: 'auto',
        useCutoff: true,
        abortOnOverflow: true,
        fallbackInstruction: DEFAULT_GEMINI_FALLBACK_INSTRUCTION,
    },
    notices: [],
    settingsVersion: SETTINGS_VERSION,
};

// ── Small pure helpers ──

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = (list, value, fallback) => (list.includes(value) ? value : fallback);
const asBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const clone = (v) => JSON.parse(JSON.stringify(v));
const str = (v) => (typeof v === 'string' && v.trim() ? v : undefined);
const triState = (v) => (v === true ? true : (v === false ? false : null));

function addNotice(s, id) {
    if (!s.notices.includes(id)) s.notices.push(id);
}

/** Numeric dotted-version compare: 1 when a > b, -1 when a < b, 0 when equal or unparseable. */
export function compareVersions(a, b) {
    const pa = String(a ?? '').split('.').map((n) => parseInt(n, 10));
    const pb = String(b ?? '').split('.').map((n) => parseInt(n, 10));
    if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return 0;
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
}

// ── Settings: load, validate, migrate ──

/** Pull settings from the three predecessor panels on first run. */
export function migrateLegacy(target, root) {
    const claude = root?.claude_max;
    if (isPlainObject(claude)) {
        if (CLAUDE_EFFORTS.includes(claude.effort)) target.claude.effort = claude.effort;
        if (CLAUDE_THINKING.includes(claude.thinking)) target.claude.thinking = claude.thinking;
        if (typeof claude.showReasoning === 'boolean') target.showReasoning = claude.showReasoning;
        if (typeof claude.identityMode === 'boolean') target.claude.identityMode = claude.identityMode;
        if (typeof claude.useResume === 'boolean') target.claude.useResume = claude.useResume;
        // A prior explicit opt-in, carried over — but fast mode draws Extra
        // Usage credits, so the panel says so once.
        if (claude.fastMode === true) {
            target.claude.fastMode = true;
            addNotice(target, 'fastModeCost');
        }
    }
    const codex = root?.codex_max;
    if (isPlainObject(codex)) {
        if (codex.effort === 'ultra') target.codex.effort = 'max';
        else if (CODEX_EFFORTS.includes(codex.effort)) target.codex.effort = codex.effort;
        if (codex.backend === 'api') target.codex.backend = 'api';
    }
    const gemini = root?.gemini_antigravity;
    if (isPlainObject(gemini)) {
        if (GEMINI_EFFORTS.includes(gemini.effort)) target.gemini.effort = gemini.effort;
        if (gemini.backend === 'api') target.gemini.backend = 'api';
    }
}

export function normalizeUrl(url) {
    return String(url ?? '').trim().replace(/\/+$/, '');
}

/**
 * Listener base URL from user input: http(s) only, no credentials, query or
 * fragment; a pasted /v1, /claude/v1 … suffix is stripped. Empty → default.
 * @returns {string|null} null when the value is not a usable base URL
 */
export function parseEndpointBase(value) {
    const raw = normalizeUrl(value).replace(/\/(claude|codex|gemini)?\/?v1$/i, '');
    if (!raw) return DEFAULT_BASE;
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return raw;
}

/**
 * Validate every persisted field in place: a hand-edited or imported
 * settings.json can carry null sub-objects, unknown enum strings or
 * non-boolean flags. Backends always fall back to 'subscription'.
 */
export function normalizeSettings(s) {
    for (const p of PROVIDER_KEYS) {
        if (!isPlainObject(s[p])) s[p] = clone(defaultSettings[p]);
    }
    s.enabled = asBool(s.enabled, true);
    s.showReasoning = asBool(s.showReasoning, true);
    s.scope = oneOf(SCOPES, s.scope, 'all');
    s.endpointBase = parseEndpointBase(s.endpointBase) ?? DEFAULT_BASE;

    const c = s.claude;
    c.backend = oneOf(BACKENDS, c.backend, 'subscription');
    c.effort = oneOf(CLAUDE_EFFORTS, c.effort, 'auto');
    c.thinking = oneOf(CLAUDE_THINKING, c.thinking, 'adaptive');
    c.identityMode = asBool(c.identityMode, false);
    c.useResume = asBool(c.useResume, true);
    c.fastMode = asBool(c.fastMode, false);

    const x = s.codex;
    x.backend = oneOf(BACKENDS, x.backend, 'subscription');
    if (x.effort === 'ultra') x.effort = 'max';
    x.effort = oneOf(CODEX_EFFORTS, x.effort, 'auto');
    x.serviceTier = oneOf(CODEX_TIERS, x.serviceTier, 'standard');
    x.reasoningSummary = oneOf(CODEX_SUMMARIES, x.reasoningSummary, 'auto');
    x.verbosity = oneOf(CODEX_VERBOSITY, x.verbosity, 'default');

    const g = s.gemini;
    g.backend = oneOf(BACKENDS, g.backend, 'subscription');
    g.effort = oneOf(GEMINI_EFFORTS, g.effort, 'auto');
    g.useCutoff = asBool(g.useCutoff, true);
    g.abortOnOverflow = asBool(g.abortOnOverflow, true);
    g.fallbackInstruction = typeof g.fallbackInstruction === 'string' && g.fallbackInstruction.trim()
        ? g.fallbackInstruction.trim()
        : DEFAULT_GEMINI_FALLBACK_INSTRUCTION;

    s.notices = Array.isArray(s.notices) ? [...new Set(s.notices.filter((n) => NOTICE_IDS.includes(n)))] : [];
    const v = Number(s.settingsVersion);
    s.settingsVersion = Number.isInteger(v) && v > 0 ? v : 1;
    return s;
}

/** One-shot migrations keyed on settingsVersion (never lowered). */
export function upgradeSettings(s) {
    // 3.0.1: the shipped default became "subscription" (overflow to a key is opt-in).
    if (s.settingsVersion < 2) {
        for (const p of PROVIDER_KEYS) if (s[p].backend === 'auto') s[p].backend = 'subscription';
    }
    // 3.1.0: Connect used to write a placeholder into the Custom API key field,
    // and the fast-mode toggle did not say it bills Extra Usage.
    if (s.settingsVersion < 3) {
        addNotice(s, 'customKeyPlaceholder');
        if (s.claude.fastMode) addNotice(s, 'fastModeCost');
    }
    s.settingsVersion = Math.max(s.settingsVersion, SETTINGS_VERSION);
    return s;
}

/**
 * The validated settings object inside `root` (SillyTavern's extension_settings),
 * created from the defaults plus the predecessor panels on first run.
 */
export function loadSettings(root) {
    let s = root[MODULE];
    if (!isPlainObject(s)) {
        s = clone(defaultSettings);
        root[MODULE] = s;
        migrateLegacy(s, root);
    }
    normalizeSettings(s);
    upgradeSettings(s);
    return s;
}

// ── Endpoint helpers ──

export function endpointFor(settings) {
    const base = normalizeUrl(settings.endpointBase) || DEFAULT_BASE;
    return settings.scope && settings.scope !== 'all' ? `${base}/${settings.scope}/v1` : `${base}/v1`;
}

export function isOurEndpoint(customUrl, settings) {
    const a = normalizeUrl(customUrl).toLowerCase();
    const base = (normalizeUrl(settings.endpointBase) || DEFAULT_BASE).toLowerCase();
    return a !== '' && (a === base || a.startsWith(base + '/'));
}

// ── One-click connect (same selector path as ST's /api-url command) ──

/**
 * Point ST's Custom source at the listener and connect ONCE. The Custom API
 * key field is never written: Custom is keyless in SillyTavern, and a
 * placeholder there would replace (deactivate) the user's real saved key.
 * @param {object} settings
 * @param {Function} [$] jQuery (injectable for tests)
 * @param {object} [toast] toastr (injectable for tests)
 */
export function connect(settings, $ = globalThis.jQuery ?? globalThis.$, toast = globalThis.toastr) {
    try {
        const endpoint = endpointFor(settings);
        if ($('#main_api').val() !== 'openai') $('#main_api').val('openai').trigger('change');
        const wasCustom = $('#chat_completion_source').val() === 'custom';
        // The endpoint MUST be set before the source change: ST's change
        // handler reconnects immediately with whatever URL is current.
        $('#custom_api_url_text').val(endpoint).trigger('input');
        if (wasCustom) $('#api_button_openai').trigger('click');
        else $('#chat_completion_source').val('custom').trigger('change'); // ST's handler reconnects once
        toast?.success?.(`Connecting to ${endpoint} — the model list will populate in a moment.`, 'Subscriptions');
    } catch (err) {
        console.error(`${TAG} connect failed`, err);
        toast?.error?.(String(err), 'Subscriptions');
    }
}

// ── Per-request injection (CHAT_COMPLETION_SETTINGS_READY) ──

/**
 * The per-request `subscriptions` object. Every value is re-validated here, so
 * nothing from persisted settings reaches the request unchecked.
 * @param {object} s panel settings
 * @param {object} [data] ST's generate_data (include_reasoning = "Request model reasoning")
 */
export function buildSubscriptionsBlock(s, data = {}) {
    const c = isPlainObject(s?.claude) ? s.claude : {};
    const x = isPlainObject(s?.codex) ? s.codex : {};
    const g = isPlainObject(s?.gemini) ? s.gemini : {};
    const claudeEffort = oneOf(CLAUDE_EFFORTS, c.effort, 'auto');
    const codexEffort = oneOf(CODEX_EFFORTS, x.effort === 'ultra' ? 'max' : x.effort, 'auto');
    const verbosity = oneOf(CODEX_VERBOSITY, x.verbosity, 'default');
    const geminiEffort = oneOf(GEMINI_EFFORTS, g.effort, 'auto');
    const geminiFallback = typeof g.fallbackInstruction === 'string' && g.fallbackInstruction.trim()
        ? g.fallbackInstruction.trim()
        : DEFAULT_GEMINI_FALLBACK_INSTRUCTION;
    return {
        // ST drops streamed reasoning while "Request model reasoning" is off,
        // so don't ask the server to stream any.
        show_reasoning: s?.showReasoning !== false && data?.include_reasoning !== false,
        claude: {
            backend: oneOf(BACKENDS, c.backend, 'subscription'),
            ...(claudeEffort !== 'auto' ? { effort: claudeEffort } : {}),
            thinking: oneOf(CLAUDE_THINKING, c.thinking, 'adaptive'),
            identity_mode: c.identityMode === true,
            use_resume: c.useResume !== false,
            fast_mode: c.fastMode === true,
        },
        codex: {
            backend: oneOf(BACKENDS, x.backend, 'subscription'),
            ...(codexEffort !== 'auto' ? { effort: codexEffort } : {}),
            service_tier: oneOf(CODEX_TIERS, x.serviceTier, 'standard'),
            reasoning_summary: oneOf(CODEX_SUMMARIES, x.reasoningSummary, 'auto'),
            ...(verbosity !== 'default' ? { verbosity } : {}),
        },
        gemini: {
            backend: oneOf(BACKENDS, g.backend, 'subscription'),
            ...(geminiEffort !== 'auto' ? { effort: geminiEffort } : {}),
            use_cutoff: g.useCutoff !== false,
            abort_on_overflow: g.abortOnOverflow !== false,
            fallback_instruction: geminiFallback,
        },
    };
}

export const STALE_KEYS = ['subscriptions', 'claude_subscription', 'codex_subscription', 'gemini_subscription'];

/** Text fallback: drop column-0 blocks this panel (or a predecessor) injected earlier. */
export function stripBlocks(text) {
    let out = String(text ?? '');
    for (const key of STALE_KEYS) {
        out = out.replace(new RegExp(`^${key}:[\\s\\S]*?(?=^\\S|\\s*$(?![\\s\\S]))`, 'm'), '');
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

function scrubStale(o) {
    if (isPlainObject(o)) for (const key of STALE_KEYS) delete o[key];
    return o;
}

/**
 * Merge `{ subscriptions: block }` into the user's Include Body text.
 *
 * SillyTavern parses custom_include_body with its YAML library and silently
 * drops the WHOLE body when it does not parse — so a naive text append breaks
 * JSON/flow bodies (`{"top_k": 20}`), list bodies (`- top_k: 20`) and bodies
 * with column-0 comments inside an old block. Parse → merge → re-serialise
 * instead (mirroring ST's own merge: objects are assigned, list items are
 * assigned in order). Re-serialising drops comments, but only in this
 * per-request copy; the saved setting is untouched.
 *
 * Fallback (no parser, or the text does not parse): strip old blocks and
 * append the block as JSON, which is valid YAML and quotes every value.
 * @param {string} text the user's Include Body (macros already substituted)
 * @param {object} block buildSubscriptionsBlock() output
 * @param {{ parse: Function, stringify: Function }} [yaml] SillyTavern.libs.yaml
 */
export function mergeIncludeBody(text, block, yaml) {
    const src = String(text ?? '').trim();
    if (yaml && typeof yaml.parse === 'function' && typeof yaml.stringify === 'function') {
        try {
            const doc = src ? yaml.parse(src, { uniqueKeys: false, logLevel: 'error' }) : null;
            let out;
            if (Array.isArray(doc)) {
                doc.forEach(scrubStale);
                doc.push({ subscriptions: block });
                out = doc;
            } else if (isPlainObject(doc)) {
                scrubStale(doc);
                doc.subscriptions = block;
                out = doc;
            } else {
                // Empty, comment-only or a bare scalar — ST ignores those anyway.
                out = { subscriptions: block };
            }
            return String(yaml.stringify(out, { lineWidth: 0 })).trim();
        } catch { /* fall through to the text path */ }
    }
    const cleaned = stripBlocks(src);
    return (cleaned ? cleaned + '\n' : '') + 'subscriptions: ' + JSON.stringify(block);
}

// ── Status interpretation (per-backend readiness) ──

export const BACKEND_SHORT = { subscription: 'subscription', auto: 'auto', api: 'API' };

/** Claude's SDK + CLI (needed by every Claude backend). */
function claudeRuntime(c) {
    if (typeof c?.available === 'boolean') return c.available;
    return c?.sdk === 'loaded' && !!c?.cli?.path;
}

/** Non-OpenAI provider the Codex CLI config routes to (used only by Auto). */
export function codexRelay(c) {
    const mp = c?.config?.modelProvider;
    return typeof mp === 'string' && mp && mp !== 'openai' ? mp : null;
}

/** API-key / relay routing configured in agy's own settings.json. */
export function geminiRelay(c) {
    const s = c?.settings ?? {};
    // The plugin's own verdict (the same rule its Subscription backend enforces) wins.
    if (typeof s.overflowOn === 'boolean') return s.overflowOn ? (s.baseUrl || s.modelProvider || 'relay') : null;
    if (typeof s.modelProvider === 'string' && s.modelProvider && s.modelProvider !== 'google') return s.modelProvider;
    if (typeof s.baseUrl === 'string' && s.baseUrl) return s.baseUrl;
    return null;
}

/**
 * Readiness of the subscription backend: `backends.subscription` from the
 * status contract, else derived from a pre-3.1.0 plugin's fields.
 * @returns {{ ready: true|false|null, message?: string }}
 */
export function subscriptionInfo(provider, c) {
    const b = c?.backends?.subscription;
    if (isPlainObject(b)) return { ready: triState(b.ready), message: str(b.message) };
    if (provider === 'claude') {
        if (!claudeRuntime(c)) return { ready: false };
        const present = c?.credential?.present;
        return { ready: present === true ? true : (present === 'unknown' ? null : false) };
    }
    if (provider === 'codex') return { ready: !!(c?.cli?.found && c?.login?.loggedIn) };
    return { ready: !!c?.cli?.found && !geminiRelay(c) };
}

/**
 * Readiness of the API backend. null = cannot tell: status cannot see a key
 * kept only in SillyTavern's Custom API key field (the chat path can).
 * @returns {{ ready: true|false|null, source?: string, baseUrl?: string, message?: string }}
 */
export function apiInfo(c) {
    const b = c?.backends?.api;
    if (isPlainObject(b)) return { ready: triState(b.ready), source: str(b.source), baseUrl: str(b.baseUrl), message: str(b.message) };
    if (c?.api?.available) return { ready: true, source: str(c.api.source), baseUrl: str(c.api.baseUrl) };
    return { ready: null };
}

const KEY_NOT_VISIBLE = 'Status cannot see a key kept only in SillyTavern\'s Custom API key field — the first chat will tell.';

function subscriptionProblem(provider, c, sub) {
    if (provider === 'claude') {
        // Not sub.message here: with the runtime missing it still describes the login ("max login").
        if (!claudeRuntime(c)) return ['err', 'unavailable', str(c?.message) ?? 'The Agent SDK or its bundled Claude CLI is missing — reinstall the plugin dependencies (without --omit=optional).'];
        return ['warn', 'needs login', sub.message ?? 'Run `claude auth login` on the SillyTavern host (on a headless machine: `claude setup-token`).'];
    }
    if (provider === 'codex') {
        if (!c?.cli?.found) return ['err', 'CLI not found', sub.message ?? 'Install the Codex CLI (`npm i -g @openai/codex`) and run `codex login`.'];
        return ['warn', 'needs ChatGPT login', sub.message ?? 'Run `codex login` with your ChatGPT account on the SillyTavern host.'];
    }
    if (!c?.cli?.found) return ['err', 'agy not found', sub.message ?? 'Install the Antigravity CLI (agy) and sign in by running it once.'];
    if (geminiRelay(c)) {
        return ['err', 'relay configured', sub.message ?? 'agy\'s settings.json routes it to an API key or relay, which Subscription refuses. Choose Auto or API to allow that, or remove the routing to use your Google sign-in.'];
    }
    return ['warn', 'not ready', sub.message];
}

/**
 * Badge state for the backend the user selected (not the provider-level
 * `ok`, which can be true with only an API key while Subscription needs a login).
 * @returns {{ tone: 'ok'|'warn'|'err'|'unknown', state: string, text: string, detail?: string }}
 */
export function providerReadiness(provider, c, backend) {
    const b = BACKENDS.includes(backend) ? backend : 'subscription';
    const result = (tone, state, detail) => ({ tone, state, text: `${state} · ${BACKEND_SHORT[b]}`, detail: detail || undefined });
    if (!isPlainObject(c)) return result('err', 'unavailable', 'No status for this provider.');
    const sub = subscriptionInfo(provider, c);
    const api = apiInfo(c);
    const notReady = () => result(...subscriptionProblem(provider, c, sub));
    const viaKey = () => {
        if (api.ready === true) return result('ok', b === 'api' ? 'ready' : 'ready (API key)', api.source ? `API key from ${api.source}` : undefined);
        if (api.ready === false) return result('warn', 'no API key', api.message);
        return result('unknown', 'key not visible', api.message ?? KEY_NOT_VISIBLE);
    };

    if (b === 'api') {
        if (provider === 'claude' && !claudeRuntime(c)) return notReady();
        return viaKey();
    }
    if (b === 'auto' && provider === 'codex') {
        // Auto runs the CLI exactly as configured, else a key.
        if (sub.ready === true || (c.cli?.found && c.login?.loggedIn)) return result('ok', 'ready');
        const relay = codexRelay(c);
        if (c.cli?.found && relay) return result('ok', 'ready', `Auto runs the Codex CLI with its configured provider "${relay}".`);
        if (c.cli?.found && c.login?.apiKeyLogin) return result('ok', 'ready (API key)', 'Auto runs the Codex CLI with its API-key login, which bills per token.');
        return api.ready === false ? notReady() : viaKey();
    }
    if (b === 'auto' && provider === 'gemini') {
        // Auto runs agy as configured (including its own routing), else a key.
        if (c.cli?.found && geminiRelay(c)) return result('ok', 'ready', 'Auto runs agy as configured, including its API-key/relay routing.');
        // An agy the plugin cannot run safely (e.g. too old to isolate) is not ready under Auto either.
        if (c.cli?.found && sub.ready === false) return notReady();
        if (c.cli?.found) return sub.ready === null
            ? result('unknown', 'sign-in unchecked', sub.message ?? 'Whether agy is signed in shows on the first chat.')
            : result('ok', 'ready');
        return api.ready === false ? notReady() : viaKey();
    }
    // Subscription — and Claude Auto, which always starts on the subscription
    // (the key is only overflow when the usage window is exhausted).
    if (sub.ready === true) return result('ok', 'ready', b === 'auto' && api.ready === true ? 'API key armed for overflow only.' : undefined);
    if (sub.ready === null) return result('unknown', provider === 'gemini' ? 'sign-in unchecked' : 'login unverified', sub.message ?? 'The login cannot be checked from here (e.g. it is in the macOS Keychain) — the first chat will tell.');
    return notReady();
}

/**
 * Deep status (Codex account + rate limits) starts a resident `codex
 * app-server`. Only ask for it when Codex can be in use: the scope includes
 * Codex AND the last status shows a Codex CLI the selected backend would run
 * (logged in, or a relay provider for Auto/API) — or the app-server already runs.
 */
export function shouldDeepProbe(settings, status) {
    if (settings?.scope !== 'all' && settings?.scope !== 'codex') return false;
    const c = status?.providers?.codex;
    if (!isPlainObject(c)) return true; // nothing known yet — the explicit button checks everything
    if (c.appServer?.running) return true;
    if (!c.cli?.found) return false;
    // ready null = the login sits where only an account read can check it (OS keyring).
    const sub = subscriptionInfo('codex', c).ready;
    if (sub === true || sub === null || c.login?.loggedIn) return true;
    return !!codexRelay(c) && settings?.codex?.backend !== 'subscription';
}

// ── Quota formatting ──

const WINDOW_LABELS = {
    five_hour: '5-hour window',
    seven_day: '7-day (all models)',
    seven_day_opus: '7-day (Opus)',
    seven_day_sonnet: '7-day (Sonnet)',
    seven_day_fable: '7-day (Fable)',
    seven_day_oauth_apps: '7-day (apps)',
    seven_day_overage_included: '7-day incl. overage',
    cinder_cove: 'one-time credit',
    primary: '5-hour window',
    secondary: 'Weekly window',
};

function prettyModelName(slug) {
    return String(slug)
        .replace(/(\d)_(?=\d)/g, '$1.')
        .split('_')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/** Human label for a quota window (known type, server label, or seven_day_<model>). */
export function windowLabel(w) {
    const type = String(w?.type ?? '');
    if (Object.prototype.hasOwnProperty.call(WINDOW_LABELS, type)) return WINDOW_LABELS[type];
    if (str(w?.label)) return w.label.trim();
    const m = type.match(/^seven_day_([a-z0-9_]+)$/i);
    if (m) return `7-day (${prettyModelName(m[1])})`;
    return type || 'window';
}

/** Currency amount with 2 decimals (Extra Usage amounts are currency units, e.g. dollars). */
export function formatMoney(amount, currency = 'USD') {
    const n = Number(amount);
    if (amount === null || amount === undefined || !Number.isFinite(n)) return '–';
    const code = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null;
    if (code) {
        try {
            return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
        } catch { /* fall through */ }
    }
    return `${n.toFixed(2)}${str(currency) ? ` ${currency}` : ''}`;
}

export function extraUsageText(extra) {
    const currency = extra?.currency ?? 'USD';
    const used = formatMoney(extra?.usedCredits ?? 0, currency);
    const limit = Number(extra?.monthlyLimit);
    return Number.isFinite(limit) && limit > 0 ? `${used} of ${formatMoney(limit, currency)} this month` : `${used} used this month`;
}

// ── Duplicate-copy guard ──

/**
 * What a copy should do when another copy already claimed the window flag.
 * A 3.1.0+ copy stores { version, url, dispose }; older ones stored `true`.
 * @returns {{ action: 'boot'|'takeover'|'dormant', warn: boolean }}
 */
export function duplicateDecision(existing, selfVersion) {
    if (!existing) return { action: 'boot', warn: false };
    if (!isPlainObject(existing)) return { action: 'dormant', warn: true };
    const cmp = compareVersions(selfVersion, existing.version);
    if (cmp > 0 && typeof existing.dispose === 'function') return { action: 'takeover', warn: true };
    return { action: 'dormant', warn: cmp !== 0 || String(existing.version) !== String(selfVersion) };
}

/** '/scripts/extensions/third-party/<folder>' from a script URL. */
export function extensionFolder(url) {
    try {
        return new URL(url).pathname.replace(/\/[^/]*$/, '') || String(url);
    } catch {
        return String(url ?? 'unknown location');
    }
}

// ══════════════════════════════════════════════
// Browser side
// ══════════════════════════════════════════════

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function row(label, valueText, tone) {
    const r = el('div', 'st-subs-status-row');
    r.append(el('span', null, label));
    r.append(el('span', ['ok', 'warn', 'err'].includes(tone) ? `st-subs-tag-${tone}` : null, valueText));
    return r;
}

function section(title) {
    const sec = el('div', 'st-subs-status-section');
    sec.append(el('b', null, title));
    return sec;
}

function quotaRows(windows) {
    const frag = document.createDocumentFragment();
    for (const w of windows ?? []) {
        const pct = typeof w.utilization === 'number' && Number.isFinite(w.utilization) ? Math.round(w.utilization * 100) : null;
        const label = windowLabel(w);
        const r = el('div', 'st-subs-quota-row');
        r.append(el('span', null, label));
        const bar = el('div', 'st-subs-quota-bar');
        bar.setAttribute('role', 'meter');
        bar.setAttribute('aria-label', label);
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        if (pct !== null) bar.setAttribute('aria-valuenow', String(Math.min(100, pct)));
        const fill = el('div', 'st-subs-quota-fill');
        fill.style.width = `${Math.min(100, pct ?? 0)}%`;
        if ((pct ?? 0) >= 90) fill.classList.add('critical');
        else if ((pct ?? 0) >= 70) fill.classList.add('warning');
        bar.append(fill);
        const resets = w.resetsAt ? ` · resets ${new Date(w.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
        r.append(bar, el('span', null, pct !== null ? `${pct}%${resets}` : `–${resets}`));
        frag.append(r);
    }
    return frag;
}

function apiKeyRow(c) {
    const api = apiInfo(c);
    if (api.ready === true) return row('API key', `${api.source ?? 'found'}${api.baseUrl ? ` → ${api.baseUrl}` : ''}`, 'ok');
    if (api.ready === false) return row('API key', api.message ?? 'none');
    return row('API key', api.message ?? 'none found here (a key kept only in SillyTavern\'s Custom API key field is not visible to status)');
}

function backendRows(provider, c, backend) {
    const frag = document.createDocumentFragment();
    const r = providerReadiness(provider, c, backend);
    frag.append(row('Selected backend', `${BACKEND_SHORT[backend] ?? backend}: ${r.state}`, r.tone));
    // The provider's own Note usually says the same thing — show "Why" only without one.
    if (r.tone !== 'ok' && r.detail && !c?.message) frag.append(row('Why', r.detail, r.tone));
    return frag;
}

function claudeSection(c, quota, backend) {
    c = isPlainObject(c) ? c : {};
    const sec = section('Claude (Anthropic Pro/Max)');
    sec.append(row('Agent SDK', c.sdk === 'loaded' ? `loaded (${c.sdkVersion ?? '?'})` : 'unavailable', c.sdk === 'loaded' ? 'ok' : 'err'));
    const cli = c.cli ?? {};
    sec.append(row('Claude CLI', cli.path ? `${cli.source ?? 'found'}${cli.version ? ` · v${cli.version}` : ''}` : 'not found', cli.path ? 'ok' : 'err'));
    const cred = c.credential ?? {};
    if (cred.present === true) {
        sec.append(row('Login', `${cred.subscriptionType ?? 'unknown plan'}${cred.rateLimitTier ? ` (${cred.rateLimitTier})` : ''}${cred.expired ? ' · token expired (refreshed on the next chat)' : ''}`, cred.expired ? 'warn' : 'ok'));
    } else if (cred.present === 'unknown') {
        sec.append(row('Login', 'stored where status cannot read it (e.g. macOS Keychain) — the first chat will tell'));
    } else {
        sec.append(row('Login', 'not logged in — run `claude auth login` (headless: `claude setup-token`)', 'err'));
    }
    sec.append(apiKeyRow(c));
    sec.append(backendRows('claude', c, backend));
    if (c.message) sec.append(row('Note', c.message, 'warn'));
    const q = quota?.claude;
    if (quota?.fetchError) sec.append(row('Quota', `unavailable (${quota.fetchError})`, 'warn'));
    else if (q && q.ok === false) sec.append(row('Quota', q.message ?? 'unavailable', cred.present === false ? undefined : 'warn'));
    else if (q?.windows?.length) sec.append(quotaRows(q.windows));
    if (q?.extraUsage?.isEnabled) sec.append(row('Extra Usage', extraUsageText(q.extraUsage)));
    if (q?.live?.isUsingOverage === true) sec.append(row('Billing now', 'Extra Usage — your plan window is used up', 'warn'));
    return sec;
}

function codexSection(c, quota, backend) {
    c = isPlainObject(c) ? c : {};
    const sec = section('Codex (ChatGPT Plus/Pro)');
    sec.append(row('Codex CLI', c.cli?.found ? `v${c.cli.version ?? '?'} (${c.cli.source})` : 'not found', c.cli?.found ? 'ok' : 'err'));
    if (c.home) sec.append(row('Codex home', c.home));
    const login = c.login ?? {};
    const sub = subscriptionInfo('codex', c);
    sec.append(row('ChatGPT login', login.loggedIn ? `${login.mode ?? 'logged in'}${c.account?.planType ? ` · ${c.account.planType}` : ''}` : 'not logged in (codex login)', sub.ready === true ? 'ok' : (login.loggedIn ? 'warn' : 'err')));
    const relay = codexRelay(c);
    if (relay) {
        sec.append(row('Routing', `relay provider "${relay}" in the CLI config — ${backend === 'auto' ? 'used by Auto' : 'used only with Auto'}`, backend === 'auto' ? 'warn' : undefined));
    } else {
        sec.append(row('Routing', 'openai (subscription)', 'ok'));
    }
    sec.append(apiKeyRow(c));
    sec.append(backendRows('codex', c, backend));
    sec.append(row('Isolation', `${c.config?.mcpServersDisabled ?? 0} MCP servers / ${c.config?.pluginsDisabled ?? 0} plugins disabled for roleplay`));
    if (c.message) sec.append(row('Note', c.message, 'warn'));
    const rl = quota?.codex ?? c.rateLimits;
    if (rl?.windows?.length) sec.append(quotaRows(rl.windows));
    if (rl?.planType) sec.append(row('Plan', rl.planType));
    return sec;
}

function geminiSection(c, backend) {
    c = isPlainObject(c) ? c : {};
    const sec = section('Gemini (Google Antigravity)');
    sec.append(row('Antigravity CLI', c.cli?.found ? `v${c.cli.version ?? '?'} (${c.cli.source})` : 'not found', c.cli?.found ? 'ok' : 'err'));
    const routing = c.settings?.routing ?? c.settings?.billing ?? 'unknown';
    const relay = geminiRelay(c);
    if (relay && backend === 'subscription') {
        sec.append(row('Routing', `${routing} — Subscription refuses this; choose Auto or API, or remove the routing from agy's settings.json`, 'err'));
    } else {
        sec.append(row('Routing', routing, relay ? 'warn' : 'ok'));
    }
    sec.append(apiKeyRow(c));
    sec.append(backendRows('gemini', c, backend));
    if (c.message) sec.append(row('Note', c.message, 'warn'));
    return sec;
}

function renderStatus(box, status, quota, settings) {
    const p = status?.providers ?? {};
    const frag = document.createDocumentFragment();
    const up = !!status?.listener?.running;
    frag.append(row('Plugin', `v${status?.version ?? '?'} · panel v${UI_VERSION} · ${status?.platform ?? '?'} · node ${status?.node ?? '?'}${up ? ` · :${status.listener.port}` : ' · listener DOWN'}`, up ? 'ok' : 'err'));
    frag.append(claudeSection(p.claude, quota, settings.claude.backend));
    frag.append(codexSection(p.codex, quota, settings.codex.backend));
    frag.append(geminiSection(p.gemini, settings.gemini.backend));
    box.replaceChildren(frag);
}

function setBadge(provider, tone, text, detail) {
    const b = document.getElementById(`st_subs_badge_${provider}`);
    if (!b) return;
    b.className = `st-subs-badge ${tone}`;
    b.textContent = text;
    b.title = detail ?? '';
}

function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}

function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), ms);
    return ac.signal;
}

/** Same-origin plugin route first, direct listener fallback; both failures are reported. */
async function pluginFetch(routePath, listenerPath, settings, timeoutMs = 20000) {
    let first;
    try {
        const res = await fetch(`${PLUGIN_ROUTE}${routePath}`, { signal: timeoutSignal(timeoutMs) });
        if (res.ok) return await res.json();
        first = `plugin route HTTP ${res.status}`;
    } catch (err) {
        first = `plugin route: ${errorText(err)}`;
    }
    const base = normalizeUrl(settings.endpointBase) || DEFAULT_BASE;
    try {
        const res = await fetch(`${base}${listenerPath}`, { signal: timeoutSignal(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        throw new Error(`${first}; listener ${base}: ${errorText(err)}`);
    }
}

// ── Settings UI helpers ──

function makeSelectRow(labelText, id, values, current, onChange, labels = {}) {
    const label = el('label', 'st-subs-label', labelText);
    label.htmlFor = id;
    const select = document.createElement('select');
    select.id = id;
    select.classList.add('text_pole');
    for (const v of values) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = labels[v] ?? v;
        if (v === current) opt.selected = true;
        select.append(opt);
    }
    select.addEventListener('change', () => onChange(select.value));
    return [label, select];
}

function makeCheckboxRow(labelText, id, checked, onChange) {
    const wrap = el('label', 'checkbox_label');
    wrap.htmlFor = id;
    const box = document.createElement('input');
    box.id = id;
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    wrap.append(box, el('span', null, labelText));
    return wrap;
}

function makeHelp(text) {
    return el('small', 'st-subs-help', text);
}

function makeButton(cls, text, ariaLabel) {
    const b = el('div', `menu_button ${cls}`, text);
    b.setAttribute('role', 'button');
    b.tabIndex = 0;
    if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
    // ST's keyboard layer already turns Enter into a click on .menu_button; add Space.
    b.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            b.click();
        }
    });
    return b;
}

function makeDrawer(parent, title, provider) {
    const drawer = el('div', 'inline-drawer st-subs-provider');
    const toggle = el('div', 'inline-drawer-toggle inline-drawer-header');
    toggle.append(el('b', null, title));
    const badge = el('span', 'st-subs-badge', '…');
    badge.id = `st_subs_badge_${provider}`;
    toggle.append(badge);
    toggle.append(el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
    const content = el('div', 'inline-drawer-content');
    drawer.append(toggle, content);
    parent.append(drawer);
    return content;
}

const CLAUDE_BACKEND_LABELS = {
    subscription: 'Subscription only (your Claude login) — default',
    auto: 'Auto (subscription first; API key only when the usage window is exhausted)',
    api: 'API key only (pay per token)',
};

const NOTICE_TEXT = {
    customKeyPlaceholder:
        'Earlier versions of this panel wrote a placeholder key ("sk-no-key-needed") into SillyTavern\'s Custom API key ' +
        'whenever you clicked Connect, which made it the active Custom key. If you keep a real key there (for an API ' +
        'backend here, or for another Custom endpoint), re-select it in SillyTavern\'s API key manager. Connect no longer ' +
        'touches the key field.',
    fastModeCost:
        'Claude Fast mode is ON. It only works on Opus 4.8, Opus 5 and Opus 5.5, and it draws Extra Usage credits, which ' +
        'are billed separately from your plan. Turn it off in the Claude section if you did not mean to pay for it.',
};

// ── Boot ──

/** Folder of another loaded copy (pre-3.1.0 copies only leave a `true` flag behind). */
function otherCopyFolder() {
    for (const s of document.querySelectorAll('script[src]')) {
        if (s.src !== SELF_URL && /\/scripts\/extensions\/[^?#]*subscriptions[^/?#]*\/index\.js(?:[?#]|$)/i.test(s.src)) return extensionFolder(s.src);
    }
    return null;
}

function boot() {
    const existing = window.__stSubscriptionsUiLoaded;
    const decision = duplicateDecision(existing, UI_VERSION);
    const toast = globalThis.toastr;
    const here = extensionFolder(SELF_URL);

    if (decision.action === 'dormant') {
        const folder = isPlainObject(existing) ? null : otherCopyFolder();
        const other = isPlainObject(existing)
            ? `v${existing.version ?? '?'} at ${extensionFolder(existing.url)}`
            : `an older copy (before 3.1.0)${folder ? ` at ${folder}` : ''}`;
        console.log(`${TAG} another copy of the Subscriptions panel is already active (${other}) — this one (v${UI_VERSION} at ${here}) stays dormant`);
        if (decision.warn) {
            toast?.warning?.(
                `Two copies of the Subscriptions panel are installed: ${other} is active, and v${UI_VERSION} at ${here} is not. ` +
                'Remove the folder you don\'t want (Extensions → Manage extensions) and reload the page.',
                'Subscriptions', { timeOut: 20000 },
            );
        }
        return;
    }
    if (decision.action === 'takeover') {
        try {
            existing.dispose();
        } catch (err) {
            console.error(`${TAG} could not deactivate the older copy — this one stays dormant`, err);
            return;
        }
        console.warn(`${TAG} replaced the older copy v${existing.version} at ${extensionFolder(existing.url)} with v${UI_VERSION} at ${here}`);
        toast?.warning?.(
            `Two copies of the Subscriptions panel are installed: v${existing.version} at ${extensionFolder(existing.url)} and ` +
            `v${UI_VERSION} at ${here}. The newer one is active — remove the older folder to stop this warning.`,
            'Subscriptions', { timeOut: 20000 },
        );
    }

    const self = { version: UI_VERSION, url: SELF_URL, dispose: null };
    window.__stSubscriptionsUiLoaded = self;

    const ctx = globalThis.SillyTavern.getContext();
    const { eventSource, eventTypes, extensionSettings, saveSettingsDebounced } = ctx;
    if (!eventTypes?.CHAT_COMPLETION_SETTINGS_READY || typeof eventSource?.on !== 'function') {
        console.error(`${TAG} this SillyTavern has no CHAT_COMPLETION_SETTINGS_READY event — the panel cannot inject settings`);
        toast?.error?.('This SillyTavern version is too old for the Subscriptions panel (1.12.0 or newer is needed).', 'Subscriptions');
        return;
    }

    const getSettings = () => loadSettings(extensionSettings);
    const yamlLib = () => globalThis.SillyTavern?.libs?.yaml;

    let disposed = false;
    let statusGen = 0;
    let statusBusy = false;
    let lastStatus = null;
    let lastQuota = null;

    function onSettingsReady(data) {
        try {
            if (disposed) return;
            const settings = getSettings();
            if (!settings.enabled) return;
            if (!data || data.chat_completion_source !== 'custom') return;
            if (!isOurEndpoint(data.custom_url, settings)) return;
            data.custom_include_body = mergeIncludeBody(data.custom_include_body, buildSubscriptionsBlock(settings, data), yamlLib());
        } catch (err) {
            console.error(`${TAG} failed to inject settings`, err);
        }
    }

    function renderBadges(settings) {
        if (!lastStatus) return;
        for (const p of PROVIDER_KEYS) {
            const r = providerReadiness(p, lastStatus.providers?.[p], settings[p].backend);
            setBadge(p, r.tone, r.text, r.detail);
        }
    }

    /** Re-render from the last status (e.g. after a backend change). */
    function rerender() {
        const settings = getSettings();
        const box = document.getElementById('st_subs_status');
        if (box && lastStatus && !statusBusy) renderStatus(box, lastStatus, lastQuota, settings);
        renderBadges(settings);
    }

    function setRefreshBusy(busy) {
        statusBusy = busy;
        const btn = document.getElementById('st_subs_status_refresh');
        if (!btn) return;
        btn.classList.toggle('st-subs-busy', busy);
        btn.setAttribute('aria-disabled', busy ? 'true' : 'false');
        btn.querySelector('i')?.classList.toggle('fa-spin', busy);
    }

    async function refreshStatus({ deep = false } = {}) {
        const box = document.getElementById('st_subs_status');
        if (!box || disposed) return;
        const gen = ++statusGen;
        const settings = getSettings();
        const query = deep ? '?deep=1' : '';
        setRefreshBusy(true);
        box.setAttribute('aria-busy', 'true');
        box.textContent = deep ? 'Checking (including Codex account and rate limits)…' : 'Checking…';
        try {
            const [status, quota] = await Promise.all([
                pluginFetch(`/status${query}`, `/status${query}`, settings, deep ? 30000 : 15000),
                pluginFetch(`/quota${query}`, `/v1/usage/quota${query}`, settings, 20000).catch((err) => ({ fetchError: errorText(err) })),
            ]);
            if (gen !== statusGen || disposed) return; // a newer refresh owns the box
            lastStatus = status;
            lastQuota = quota;
            renderStatus(box, status, quota, getSettings());
            renderBadges(getSettings());
        } catch (err) {
            if (gen !== statusGen || disposed) return;
            box.replaceChildren(el('span', 'st-subs-tag-err', `Offline (${errorText(err)}). Is the server plugin running? Check the SillyTavern console for [subscriptions] lines.`));
            for (const p of PROVIDER_KEYS) setBadge(p, 'err', 'offline', errorText(err));
        } finally {
            if (gen === statusGen) {
                setRefreshBusy(false);
                box.removeAttribute('aria-busy');
            }
        }
    }

    function addExtensionSettings(settings) {
        const container = document.getElementById('extensions_settings') ?? document.body;
        const drawer = el('div', 'inline-drawer st-subs-root');
        container.append(drawer);

        const toggle = el('div', 'inline-drawer-toggle inline-drawer-header');
        toggle.append(el('b', null, 'Subscriptions (Claude Max · Codex · Gemini)'));
        toggle.append(el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
        const content = el('div', 'inline-drawer-content');
        drawer.append(toggle, content);
        // First open: one shallow check so the badges don't sit at "…" (no Codex app-server start).
        toggle.addEventListener('click', () => { if (!lastStatus && !statusBusy) refreshStatus({ deep: false }); }, { once: true });

        // Legacy panels still loaded?
        const legacy = [];
        if (window.__claudeMaxUiLoaded) legacy.push('Claude Max');
        if (window.__codexMaxUiLoaded) legacy.push('Codex Max');
        if (window.__geminiAntigravityUiLoaded) legacy.push('Gemini Antigravity');
        if (legacy.length) {
            content.append(el('div', 'st-subs-notice', `Old panel(s) still installed: ${legacy.join(', ')}. This panel replaces them — remove their extensions (Extensions → Manage) to avoid duplicate settings.`));
        }

        // One-time notices
        const notices = el('div', 'st-subs-notices');
        content.append(notices);
        const renderNotices = () => {
            notices.replaceChildren();
            for (const id of settings.notices) {
                const n = el('div', 'st-subs-notice', NOTICE_TEXT[id]);
                n.setAttribute('role', 'note');
                const dismiss = makeButton('st-subs-notice-dismiss', 'Got it', 'Dismiss this notice');
                dismiss.addEventListener('click', () => {
                    settings.notices = settings.notices.filter((x) => x !== id);
                    saveSettingsDebounced();
                    renderNotices();
                });
                n.append(dismiss);
                notices.append(n);
            }
        };
        renderNotices();

        // Connect + scope
        const connectBtn = makeButton('st-subs-connect', 'Connect');
        connectBtn.addEventListener('click', () => connect(getSettings()));
        content.append(connectBtn);

        const [scopeLabel, scopeSelect] = makeSelectRow('Connect to', 'stSubsScope', SCOPES, settings.scope, (v) => {
            settings.scope = oneOf(SCOPES, v, 'all');
            saveSettingsDebounced();
            endpointPreview.textContent = `Endpoint: ${endpointFor(settings)}`;
        }, { all: 'All subscriptions (one model list)', claude: 'Claude only', codex: 'Codex / ChatGPT only', gemini: 'Gemini / Antigravity only' });
        content.append(scopeLabel, scopeSelect);
        const endpointPreview = makeHelp(`Endpoint: ${endpointFor(settings)}`);
        content.append(endpointPreview);
        content.append(makeHelp(
            'One click does the whole setup: switches the API to Chat Completion → Custom (OpenAI-compatible), fills in the ' +
            'endpoint and connects. No API key is needed, and Connect never changes SillyTavern\'s Custom API key field. Then ' +
            'pick any model from the normal model dropdown — claude-* goes to your Claude subscription, gpt-* to ChatGPT/Codex, ' +
            'gemini-* to Antigravity. "All subscriptions" lists every provider that is usable on this machine; pick a single ' +
            'provider if you prefer a shorter list.',
        ));

        const endpointLabel = el('label', 'st-subs-label', 'Listener base URL (advanced)');
        endpointLabel.htmlFor = 'stSubsEndpoint';
        const endpointInput = document.createElement('input');
        endpointInput.type = 'text';
        endpointInput.id = 'stSubsEndpoint';
        endpointInput.classList.add('text_pole');
        endpointInput.value = settings.endpointBase;
        endpointInput.setAttribute('aria-describedby', 'stSubsEndpointHelp');
        const endpointHelp = makeHelp('Only change this if you set ST_SUBSCRIPTIONS_PORT / _HOST. Enter just the origin (http://host:port); /v1 or /claude/v1 is added automatically.');
        endpointHelp.id = 'stSubsEndpointHelp';
        endpointInput.addEventListener('input', () => {
            const parsed = parseEndpointBase(endpointInput.value);
            endpointInput.classList.toggle('st-subs-invalid', parsed === null);
            endpointInput.setAttribute('aria-invalid', parsed === null ? 'true' : 'false');
            if (parsed === null) return; // keep the last valid value
            settings.endpointBase = parsed;
            saveSettingsDebounced();
            endpointPreview.textContent = `Endpoint: ${endpointFor(settings)}`;
        });
        content.append(endpointLabel, endpointInput, endpointHelp);

        content.append(makeCheckboxRow('Enabled (inject these settings into requests to the proxy)', 'stSubsEnabled', settings.enabled, (v) => { settings.enabled = v; saveSettingsDebounced(); }));
        content.append(makeCheckboxRow('Show reasoning (collapsible thinking box, all providers)', 'stSubsShowReasoning', settings.showReasoning, (v) => { settings.showReasoning = v; saveSettingsDebounced(); }));
        content.append(makeHelp(
            'Display toggle only — it does not change whether a model thinks. ON: thinking summaries stream into SillyTavern\'s ' +
            'collapsible reasoning box. SillyTavern also needs "Request model reasoning" turned on (AI Response Configuration); ' +
            'while that is off, no thinking is streamed at all. Claude and Codex stream summaries; Antigravity\'s CLI never ' +
            'exposes Gemini\'s thoughts.',
        ));

        const onBackendChange = () => { saveSettingsDebounced(); rerender(); };

        // ── Claude ──
        const claude = makeDrawer(content, 'Claude — Anthropic Pro/Max', 'claude');
        {
            const [l, s] = makeSelectRow('Backend', 'stSubsClaudeBackend', BACKENDS, settings.claude.backend, (v) => { settings.claude.backend = oneOf(BACKENDS, v, 'subscription'); onBackendChange(); }, CLAUDE_BACKEND_LABELS);
            claude.append(l, s);
            claude.append(makeHelp(
                'Subscription only (default) bills your Claude Pro/Max login and never an API key — before each request the ' +
                'plugin checks that the CLI really uses that login. If Extra Usage is enabled on your Claude account, requests ' +
                'past your plan window (and Fast mode / the 4.6 "(1M context)" entries) are billed as Extra Usage; turn it off ' +
                'in your Claude account settings if you do not want that. Log in on the SillyTavern host with ' +
                '`claude auth login` (on a headless machine: `claude setup-token`). Auto always starts on the subscription and ' +
                'moves a request to the API key only when your plan\'s usage window is exhausted or rate limiting persists after ' +
                'retries — never just because a key exists or no login was found. API bills an Anthropic key or a compatible ' +
                'relay token from SillyTavern\'s Custom API key field, ST_SUBSCRIPTIONS_CLAUDE_API_KEY, ANTHROPIC_API_KEY / ' +
                'ANTHROPIC_AUTH_TOKEN or ~/.claude/settings.json (set ANTHROPIC_BASE_URL or ST_SUBSCRIPTIONS_CLAUDE_BASE_URL ' +
                'for a relay).',
            ));
            const [el2, es] = makeSelectRow('Reasoning effort', 'stSubsClaudeEffort', CLAUDE_EFFORTS, settings.claude.effort, (v) => { settings.claude.effort = oneOf(CLAUDE_EFFORTS, v, 'auto'); saveSettingsDebounced(); }, { auto: 'Auto (model default)', xhigh: 'xhigh (deeper)', max: 'max (deepest)' });
            claude.append(el2, es);
            claude.append(makeHelp(
                'How hard Claude reasons before replying — low is fastest, max thinks longest (slower replies, more quota). ' +
                'Auto uses the model\'s own default: medium on Opus 5.5 and Sonnet 5.5, xhigh on Opus 4.7, high on most others. ' +
                'A level the model does not support steps down automatically (xhigh → high on the 4.6 models); Opus 4.5, ' +
                'Sonnet 4.5 and Haiku 4.5 take no effort setting.',
            ));
            const [tl, ts] = makeSelectRow('Thinking mode', 'stSubsClaudeThinking', CLAUDE_THINKING, settings.claude.thinking, (v) => { settings.claude.thinking = oneOf(CLAUDE_THINKING, v, 'adaptive'); saveSettingsDebounced(); }, { adaptive: 'Adaptive (model decides — recommended)', on: 'On (fixed budget on the 4.x models)', off: 'Off (ignored by always-thinking models)' });
            claude.append(tl, ts);
            claude.append(makeHelp('Fable 5 / 5.1, Opus 5.5 and Sonnet 5.5 always think, so Off is ignored there; Off works on every other model. On forces a fixed thinking budget where a model allows one (Opus/Sonnet 4.6 and the 4.5 models); on newer models it behaves like Adaptive. Thinking counts toward the max response length.'));
            claude.append(makeHelp(
                'Context: Fable, Opus 4.7 and newer, and Sonnet 5 and newer have a 1M-token window built in, so each is listed ' +
                'once (older saved "[1m]" ids still work). Only Opus 4.6 and Sonnet 4.6 keep a separate "(1M context)" entry, ' +
                'which may draw Extra Usage credits; if your plan has none for 1M, the request runs at 200k and 1M is tried ' +
                'again after an hour.',
            ));
            claude.append(makeCheckboxRow('Session resume (real multi-turn context + prompt caching)', 'stSubsClaudeResume', settings.claude.useResume, (v) => { settings.claude.useResume = v; saveSettingsDebounced(); }));
            claude.append(makeHelp('ON (recommended): the chat is replayed as a genuine multi-turn Claude session — better who-said-what tracking and working prompt caching. OFF flattens the chat into one text block (troubleshooting only).'));
            claude.append(makeCheckboxRow('Identity mode (tell the model which Claude it is)', 'stSubsClaudeIdentity', settings.claude.identityMode, (v) => { settings.claude.identityMode = v; saveSettingsDebounced(); }));
            claude.append(makeHelp(
                'OFF (recommended): your system prompt, after the Claude CLI\'s fixed one-line agent identity and its short ' +
                'environment note (working directory — a plugin folder, platform, shell, OS, model name, date), which no ' +
                'subscription setting removes. ON: also adds one line ' +
                'naming the exact model (e.g. Claude Opus 5.5), so a character can answer "which model are you?". ON adds no ' +
                'Claude Code preamble and no details about this machine.',
            ));
            claude.append(makeCheckboxRow('Fast mode (Opus 4.8 / 5 / 5.5 only — draws Extra Usage credits)', 'stSubsClaudeFast', settings.claude.fastMode, (v) => {
                settings.claude.fastMode = v;
                if (!v && settings.notices.includes('fastModeCost')) {
                    settings.notices = settings.notices.filter((x) => x !== id);
                    renderNotices();
                }
                saveSettingsDebounced();
            }));
            claude.append(makeHelp(
                'Faster output on Opus 4.8, Opus 5 and Opus 5.5; ignored on every other model. It bills Extra Usage credits, ' +
                'which are charged separately from your plan\'s usage window, so it needs Extra Usage enabled on your account. ' +
                'The server log shows whether it was applied.',
            ));
            claude.append(makeHelp('A safety refusal is shown as an error. The plugin never retries it and never switches to a different model.'));
        }

        // ── Codex ──
        const codex = makeDrawer(content, 'Codex — ChatGPT Plus/Pro', 'codex');
        {
            const [l, s] = makeSelectRow('Backend', 'stSubsCodexBackend', BACKENDS, settings.codex.backend, (v) => { settings.codex.backend = oneOf(BACKENDS, v, 'subscription'); onBackendChange(); }, { subscription: 'Subscription only (ChatGPT login, provider openai) — default', auto: 'Auto (follow the Codex CLI config, including any provider you switched it to)', api: 'API key only (pay per token)' });
            codex.append(l, s);
            codex.append(makeHelp(
                'Runs through the Codex CLI\'s app-server with a clean system prompt (no coding preamble, no MCP servers, no ' +
                'tools). Subscription needs `codex login` with your ChatGPT account on the SillyTavern host and never bills an ' +
                'API key. Auto runs the CLI exactly as configured (including a relay provider set in config.toml) and uses an API ' +
                'key only when the CLI is missing or not logged in. API uses OPENAI_API_KEY (+ OPENAI_BASE_URL for a compatible ' +
                'relay) or the Custom API key field directly.',
            ));
            const [el2, es] = makeSelectRow('Reasoning effort', 'stSubsCodexEffort', CODEX_EFFORTS, settings.codex.effort, (v) => { settings.codex.effort = oneOf(CODEX_EFFORTS, v, 'auto'); saveSettingsDebounced(); }, { auto: 'Auto (model default)', max: 'max (deepest)' });
            codex.append(el2, es);
            codex.append(makeHelp('Auto sends the default of the chosen model (e.g. medium for GPT-5.5) — the model_reasoning_effort in your Codex CLI config (a coding setting) is not used. Clamped to what the chosen model supports (the model list is read live from your account). A saved "ultra" setting is treated as max — for roleplay they are the same.'));
            const [stl, sts] = makeSelectRow('Service tier', 'stSubsCodexTier', CODEX_TIERS, settings.codex.serviceTier, (v) => { settings.codex.serviceTier = oneOf(CODEX_TIERS, v, 'standard'); saveSettingsDebounced(); }, { standard: 'Standard', priority: 'Fast (priority — 2× speed, more usage)', ultrafast: 'Ultrafast (where offered)' });
            codex.append(stl, sts);
            const [rl, rs] = makeSelectRow('Reasoning summary', 'stSubsCodexSummary', CODEX_SUMMARIES, settings.codex.reasoningSummary, (v) => { settings.codex.reasoningSummary = oneOf(CODEX_SUMMARIES, v, 'auto'); saveSettingsDebounced(); }, { auto: 'Auto', concise: 'Concise', detailed: 'Detailed', none: 'None' });
            codex.append(rl, rs);
            codex.append(makeHelp('How much of the model\'s reasoning is summarised into the thoughts box.'));
            const [vl, vs] = makeSelectRow('Verbosity', 'stSubsCodexVerbosity', CODEX_VERBOSITY, settings.codex.verbosity, (v) => { settings.codex.verbosity = oneOf(CODEX_VERBOSITY, v, 'default'); saveSettingsDebounced(); }, { default: 'Default', low: 'Low (terse)', medium: 'Medium', high: 'High (longer replies)' });
            codex.append(vl, vs);
            codex.append(makeHelp('How long GPT\'s replies tend to be. Default follows SillyTavern\'s own Verbosity setting (AI Response Configuration) when it is not Auto, otherwise medium.'));
        }

        // ── Gemini ──
        const gemini = makeDrawer(content, 'Gemini — Google Antigravity', 'gemini');
        {
            const [l, s] = makeSelectRow('Backend', 'stSubsGeminiBackend', BACKENDS, settings.gemini.backend, (v) => { settings.gemini.backend = oneOf(BACKENDS, v, 'subscription'); onBackendChange(); }, { subscription: 'Antigravity CLI only (agy sign-in) — default', auto: 'Auto (agy as configured, else API key)', api: 'API key only (pay per token)' });
            gemini.append(l, s);
            gemini.append(makeHelp(
                'Subscription runs agy on your Google sign-in. If agy\'s own settings.json routes it to a Gemini API key or a ' +
                'relay (modelProvider / GOOGLE_GEMINI_BASE_URL), Subscription refuses the request — choose Auto (runs agy as ' +
                'configured) or API to allow that. Each agy turn runs a plugin-owned, tool-less agent: your GEMINI.md, skills, ' +
                'rules and MCP servers never reach the model. Images are not supported on the agy path (use API). API sends the ' +
                'chat straight to Google\'s OpenAI-compatible Gemini endpoint with GEMINI_API_KEY (or to GOOGLE_GEMINI_BASE_URL ' +
                'for a compatible relay); a key typed into SillyTavern\'s Custom API key field goes to Google unless ' +
                'ST_SUBSCRIPTIONS_GEMINI_BASE_URL is set.',
            ));
            const [el2, es] = makeSelectRow('Reasoning effort', 'stSubsGeminiEffort', GEMINI_EFFORTS, settings.gemini.effort, (v) => { settings.gemini.effort = oneOf(GEMINI_EFFORTS, v, 'auto'); saveSettingsDebounced(); }, { auto: 'Auto (from the model name, e.g. …-high)', low: 'Low (fastest)', medium: 'Medium', high: 'High (deepest)' });
            gemini.append(el2, es);
            gemini.append(makeHelp('Antigravity encodes effort in the model id (gemini-3.8-flash-high). Setting it here overrides that suffix where the model offers the level — Gemini 3.1 Pro has High and Low only; an unavailable level is rejected with the list of real ones.'));

            gemini.append(makeCheckboxRow(
                'Use <agy_cutoff> prompt partitioning',
                'stSubsGeminiUseCutoff',
                settings.gemini.useCutoff !== false,
                (v) => {
                    settings.gemini.useCutoff = v;
                    saveSettingsDebounced();
                },
            ));
            gemini.append(makeHelp(
                'When enabled and `<agy_cutoff>` is placed in SillyTavern\'s Prompt Manager, everything above `<agy_cutoff>` (any ' +
                'role) plus any `system` prompts below it are placed into `agent.md` (`# System_Instructions`), while `user` and ' +
                '`assistant` turns below `<agy_cutoff>` are piped on STDIN (capped at 180 KB). When disabled (or if `<agy_cutoff>` ' +
                'is not present), all `system` prompts go to `agent.md` and all `user`/`assistant` turns go to STDIN (any ' +
                '`<agy_cutoff>` tag left in your preset is automatically stripped).',
            ));

            gemini.append(makeCheckboxRow(
                'Stop generation on context overflow (180 KB STDIN / 720 KB total)',
                'stSubsGeminiAbortOverflow',
                settings.gemini.abortOnOverflow !== false,
                (v) => {
                    settings.gemini.abortOnOverflow = v;
                    saveSettingsDebounced();
                },
            ));
            gemini.append(makeHelp(
                'ON (default): aborts generation immediately with an error message if STDIN exceeds 180 KB (instead of spilling ' +
                'turns into `agent.md`) or if total context exceeds 720 KB (instead of dropping older turns). OFF: automatically ' +
                'spills excess STDIN turns into `agent.md` and drops the oldest non-system turns when over 720 KB.',
            ));

            const fallbackLabel = el('label', 'st-subs-label', '# System_Instructions fallback text');
            fallbackLabel.htmlFor = 'stSubsGeminiFallbackInstruction';
            const fallbackInput = document.createElement('input');
            fallbackInput.type = 'text';
            fallbackInput.id = 'stSubsGeminiFallbackInstruction';
            fallbackInput.classList.add('text_pole');
            fallbackInput.value = settings.gemini.fallbackInstruction || DEFAULT_GEMINI_FALLBACK_INSTRUCTION;
            fallbackInput.placeholder = DEFAULT_GEMINI_FALLBACK_INSTRUCTION;
            fallbackInput.setAttribute('aria-describedby', 'stSubsGeminiFallbackHelp');
            const defaultFallbackHelpText =
                'Used under `# System_Instructions` in `agent.md` only when no prompts are routed to `agent.md` (for example, ' +
                'when all prompts are `user`/`assistant` after `<agy_cutoff>`). Do not leave empty — `agy` drops empty sections, ' +
                `so an empty box automatically falls back to "${DEFAULT_GEMINI_FALLBACK_INSTRUCTION}".`;
            const fallbackHelp = makeHelp(defaultFallbackHelpText);
            fallbackHelp.id = 'stSubsGeminiFallbackHelp';
            fallbackInput.addEventListener('input', () => {
                const raw = fallbackInput.value.trim();
                const isEmpty = !raw;
                fallbackInput.classList.toggle('st-subs-invalid', isEmpty);
                fallbackInput.setAttribute('aria-invalid', isEmpty ? 'true' : 'false');
                if (isEmpty) {
                    fallbackHelp.textContent = `Warning: # System_Instructions cannot be empty in agent.md — falling back to "${DEFAULT_GEMINI_FALLBACK_INSTRUCTION}".`;
                    settings.gemini.fallbackInstruction = DEFAULT_GEMINI_FALLBACK_INSTRUCTION;
                } else {
                    fallbackHelp.textContent = defaultFallbackHelpText;
                    settings.gemini.fallbackInstruction = raw;
                }
                saveSettingsDebounced();
            });
            gemini.append(fallbackLabel, fallbackInput, fallbackHelp);
        }

        // ── Status & quota ──
        const statusHeader = el('div', 'st-subs-status-header');
        statusHeader.append(el('b', null, 'Status & quota'));
        const statusRefresh = makeButton('st-subs-status-refresh', undefined, 'Refresh status');
        statusRefresh.id = 'st_subs_status_refresh';
        statusRefresh.title = 'Refresh status (also checks the Codex account and rate limits when Codex is in use)';
        statusRefresh.setAttribute('aria-disabled', 'false');
        statusRefresh.append(el('i', 'fa-solid fa-rotate'));
        statusRefresh.addEventListener('click', () => {
            if (statusBusy) return;
            const current = getSettings();
            refreshStatus({ deep: shouldDeepProbe(current, lastStatus) });
        });
        statusHeader.append(statusRefresh);
        const statusBox = el('div', 'st-subs-status-box', 'Press refresh to check the three subscriptions.');
        statusBox.id = 'st_subs_status';
        statusBox.setAttribute('aria-live', 'polite');
        content.append(statusHeader, statusBox);

        content.append(el('small', 'st-subs-hint',
            'Leave SillyTavern\'s native "Reasoning Effort" dropdown on Auto — the per-provider effort above replaces it. ' +
            'Temperature/Top-P only apply on Gemini\'s API backend (the CLIs expose no sampling controls).'));

        return drawer;
    }

    const before = JSON.stringify(extensionSettings[MODULE] ?? null);
    const settings = getSettings();
    if (JSON.stringify(settings) !== before) saveSettingsDebounced();

    const drawer = addExtensionSettings(settings);
    eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);

    self.dispose = () => {
        disposed = true;
        try { eventSource.removeListener?.(eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady); } catch { /* ignore */ }
        drawer.remove();
    };
    console.log(`${TAG} UI extension v${UI_VERSION} loaded from ${here}`);
}

if (typeof window !== 'undefined' && typeof globalThis.SillyTavern?.getContext === 'function') {
    try {
        boot();
    } catch (err) {
        console.error(`${TAG} UI extension failed to start`, err);
    }
}