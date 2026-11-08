// ──────────────────────────────────────────────
// Per-request settings extraction
// ──────────────────────────────────────────────
//
// The companion UI extension injects a `subscriptions` object into the request
// body via SillyTavern's `custom_include_body` channel — the only per-request
// path ST's backend forwards unconditionally for Custom sources. Layout:
//
//   subscriptions:
//     provider: claude | codex | gemini      (optional — normally inferred from the model id)
//     show_reasoning: true
//     claude:  { backend, effort, thinking, thinking_budget, identity_mode, use_resume, fast_mode }
//     codex:   { backend, effort, service_tier, reasoning_summary, verbosity }
//     gemini:  { backend, effort, use_cutoff, abort_on_overflow, fallback_instruction }
//
// The legacy namespaces of the three predecessor plugins (`claude_subscription`,
// `codex_subscription`, `gemini_subscription`) are still honoured so an old
// companion panel keeps working during migration. Direct API users can also
// send the standard OpenAI `reasoning_effort` and (GPT-5 family) `verbosity`
// fields. Claude fast mode draws Extra Usage credits, so it is read ONLY from
// the subscriptions / claude_subscription namespaces — never from a generic
// top-level field another client might send.

import { extractStops } from './common/stops.js';
import { DEFAULT_SYSTEM_INSTRUCTION } from './gemini/agy.js';

export const PROVIDERS = ['claude', 'codex', 'gemini'];

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const CLAUDE_THINKING = ['off', 'adaptive', 'on'];
// 'ultra' stays accepted for old saved panels; the Codex runner maps it down.
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const CODEX_SUMMARIES = ['auto', 'concise', 'detailed', 'none'];
export const CODEX_SERVICE_TIERS = ['standard', 'priority', 'ultrafast'];
export const CODEX_VERBOSITY = ['low', 'medium', 'high'];
export const GEMINI_EFFORTS = ['low', 'medium', 'high'];

const oneOf = (list, value, fallback) => (list.includes(value) ? value : fallback);
const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
const bool = (...candidates) => {
    for (const c of candidates) if (typeof c === 'boolean') return c;
    return undefined;
};
const nonEmptyStr = (...candidates) => {
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return undefined;
};
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Legacy backend vocabularies → the unified one. Default: subscription. */
function normalizeBackend(value) {
    const v = String(value ?? '').toLowerCase();
    if (!v) return 'subscription'; // nothing sent → the subscription, never a key
    if (v === 'auto') return 'auto';
    if (['subscription', 'cli', 'agy', 'codex', 'sdk', 'oauth'].includes(v)) return 'subscription';
    if (['api', 'direct', 'key'].includes(v)) return 'api';
    return 'subscription'; // unknown values never opt anyone into billing
}

/**
 * @param {object} body OpenAI chat completions request body
 * @returns {{
 *   provider: string|undefined,
 *   showReasoning: boolean,
 *   reasoningEffort: string|undefined,
 *   maxTokens: number|undefined,
 *   stops: string[],
 *   temperature: number|undefined,
 *   topP: number|undefined,
 *   claude: object, codex: object, gemini: object,
 * }}
 */
export function extractRequestSettings(body) {
    body = body ?? {};
    const ns = obj(body.subscriptions);
    const legacyClaude = obj(body.claude_subscription);
    const legacyCodex = obj(body.codex_subscription);
    const legacyGemini = obj(body.gemini_subscription);

    const claudeNs = { ...legacyClaude, ...obj(ns.claude) };
    const codexNs = { ...legacyCodex, ...obj(ns.codex) };
    const geminiNs = { ...legacyGemini, ...obj(ns.gemini) };

    const genericEffort = typeof body.reasoning_effort === 'string'
        ? body.reasoning_effort
        : (typeof body.reasoning?.effort === 'string' ? body.reasoning.effort : undefined);

    const showReasoning = bool(ns.show_reasoning, claudeNs.show_reasoning, codexNs.show_reasoning, geminiNs.show_reasoning) ?? true;

    const maxTokens = Number.isFinite(body.max_tokens) && body.max_tokens > 0
        ? Math.floor(body.max_tokens)
        : (Number.isFinite(body.max_completion_tokens) && body.max_completion_tokens > 0
            ? Math.floor(body.max_completion_tokens)
            : undefined);

    const temperature = Number.isFinite(body.temperature) ? body.temperature : undefined;
    const topP = Number.isFinite(body.top_p) ? body.top_p : undefined;

    const thinkingBudget = Number.isFinite(claudeNs.thinking_budget) && claudeNs.thinking_budget > 0
        ? Math.floor(claudeNs.thinking_budget)
        : undefined;

    return {
        provider: PROVIDERS.includes(String(ns.provider ?? '').toLowerCase()) ? String(ns.provider).toLowerCase() : undefined,
        showReasoning,
        reasoningEffort: genericEffort,
        maxTokens,
        stops: extractStops(body),
        temperature,
        topP,
        claude: {
            backend: normalizeBackend(claudeNs.backend),
            effort: oneOf(CLAUDE_EFFORTS, claudeNs.effort, undefined) ?? oneOf(CLAUDE_EFFORTS, genericEffort, undefined),
            thinking: oneOf(CLAUDE_THINKING, claudeNs.thinking, 'adaptive'),
            thinkingBudget,
            identityMode: claudeNs.identity_mode === true,
            useResume: claudeNs.use_resume !== false,
            // Extra Usage credits — opt-in through the panel's namespace only.
            fastMode: bool(claudeNs.fast_mode, claudeNs.fastMode) ?? false,
        },
        codex: {
            backend: normalizeBackend(codexNs.backend),
            effort: oneOf(CODEX_EFFORTS, codexNs.effort, undefined) ?? oneOf(CODEX_EFFORTS, genericEffort, undefined),
            serviceTier: oneOf(CODEX_SERVICE_TIERS, codexNs.service_tier, 'standard'),
            reasoningSummary: oneOf(CODEX_SUMMARIES, codexNs.reasoning_summary, 'auto'),
            // undefined = not chosen ('auto' / nothing sent); the runner picks its own default.
            verbosity: oneOf(CODEX_VERBOSITY, lower(codexNs.verbosity), undefined) ?? oneOf(CODEX_VERBOSITY, lower(body.verbosity), undefined),
        },
        gemini: {
            backend: normalizeBackend(geminiNs.backend),
            effort: oneOf(GEMINI_EFFORTS, geminiNs.effort, undefined) ?? oneOf(GEMINI_EFFORTS, genericEffort, undefined),
            useCutoff: bool(geminiNs.use_cutoff, geminiNs.useCutoff) ?? true,
            abortOnOverflow: bool(geminiNs.abort_on_overflow, geminiNs.abortOnOverflow) ?? true,
            fallbackInstruction: nonEmptyStr(geminiNs.fallback_instruction, geminiNs.fallbackInstruction) ?? DEFAULT_SYSTEM_INSTRUCTION,
        },
    };
}