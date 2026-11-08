// ──────────────────────────────────────────────
// Gemini provider — chat runner
// ──────────────────────────────────────────────
//
// backend = subscription → agy print mode on the Google sign-in only. When
//                          agy's settings.json is set up for API-key billing
//                          (modelProvider, or a GOOGLE_GEMINI_BASE_URL) the
//                          request is refused, and agy always runs with every
//                          Gemini key / base-URL / gateway variable removed.
// backend = api          → direct OpenAI-compatible HTTP with a Gemini key to
//                          Google's OpenAI-compatible endpoint, or to the base
//                          URL that comes from the same place as the key.
// backend = auto         → agy when installed, following agy's own
//                          configuration (including its API-key mode); else
//                          the api backend when a key exists.
//
// agy turns run the isolated chat agent (see agy.js). System prompts and any
// messages before `<agy_cutoff>` are written into a per-run custom agent
// definition (sent via systemInstruction, which is exempt from the per-step
// STDIN cap), while post-cutoff user/assistant turns are piped on STDIN.
// Images on the current turn are refused on agy (use the api backend); older
// ones become "[image omitted]".

import { isForeignKey } from '../common/keys.js';
import {
    agyLaunchSpec, runAgy, readAntigravitySettings, agyBilling,
    AGY_MAX_STDIN_BYTES, AGY_MAX_TOTAL_BYTES, CHAT_AGENT_NAME, DEFAULT_SYSTEM_INSTRUCTION, buildChatAgentMd,
} from './agy.js';
import { resolveGeminiModel, listGeminiModels, geminiCatalog, agyModelId } from './models.js';
import { runOpenAiCompat } from '../common/openai-compat.js';
import { contentToText, splitConversation } from '../common/messages.js';
import { toOpenAiUsage } from '../common/sse.js';
import { abortError } from '../common/abort.js';
import { bearerFromRequest } from '../claude/env.js';

const TAG = '[subscriptions/gemini]';
const GOOGLE_OPENAI_COMPAT_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const GOOGLE_HOST = 'generativelanguage.googleapis.com';
const utf8Bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

export const AGY_CUTOFF_MARKER = '<agy_cutoff>';

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitUtf8Tail(text, maxTailBytes) {
    const str = String(text ?? '');
    if (maxTailBytes <= 0) return { head: str, tail: '' };
    if (utf8Bytes(str) <= maxTailBytes) return { head: '', tail: str };
    const buf = Buffer.from(str, 'utf8');
    let start = buf.length - maxTailBytes;
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
    const nl = buf.indexOf(0x0a, start);
    if (nl !== -1 && nl - start <= 2048 && nl + 1 < buf.length) start = nl + 1;
    return {
        head: buf.subarray(0, start).toString('utf8').trimEnd(),
        tail: buf.subarray(start).toString('utf8'),
    };
}

function sliceUtf8Head(text, maxHeadBytes) {
    const str = String(text ?? '');
    if (maxHeadBytes <= 0) return '';
    if (utf8Bytes(str) <= maxHeadBytes) return str;
    const buf = Buffer.from(str, 'utf8');
    let end = maxHeadBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    return buf.subarray(0, end).toString('utf8');
}

const hasImage = (m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'image_url');

/**
 * Partition an OpenAI messages[] array into `agent.md` (`# System_Instructions`)
 * and `stdin` (`prompt`) for agy:
 *  1. When `useCutoff` is true and `cutoffMarker` (default `<agy_cutoff>`, case-insensitive) is present:
 *     - Everything before `cutoffMarker` (any role) goes into `agent.md`.
 *     - Any `system` / `developer` message after `cutoffMarker` also goes into `agent.md`.
 *     - All `user` / `assistant` / `tool` messages after `cutoffMarker` go into `stdin`.
 *  2. When `useCutoff` is false or `cutoffMarker` is NOT present:
 *     - Every `system` / `developer` message goes into `agent.md`.
 *     - Every `user` / `assistant` / `tool` message goes into `stdin`.
 *     - Any literal `cutoffMarker` tag left in the prompt is still stripped cleanly.
 *  3. All `agent.md` blocks stay in exact sequential order inside a single
 *     `{ heading: 'System_Instructions', content }` section.
 *  4. Empty `stdin` guard moves the last non-system block from `agent.md` into
 *     `stdin` (or falls back to `"[Start]"`).
 *  5. Enforces `maxStdinBytes` (180 KB) and `maxTotalBytes` (720 KB):
 *     - When `abortOnOverflow` is true, throws an HTTP 400 error if `stdin`
 *       exceeds `maxStdinBytes` or total size exceeds `maxTotalBytes`.
 *     - Otherwise, spills oldest `stdin` blocks into the end of `agent.md` and
 *       drops oldest non-system blocks first before trimming system blocks.
 *
 * @param {object[]} messages
 * @param {{
 *   userLabel?: string,
 *   assistantLabel?: string,
 *   cutoffMarker?: string,
 *   useCutoff?: boolean,
 *   abortOnOverflow?: boolean,
 *   fallbackInstruction?: string,
 *   maxStdinBytes?: number,
 *   maxTotalBytes?: number,
 * }} [opts]
 * @returns {{
 *   prompt: string,
 *   agentSections: Array<{ heading: string, content: string }>,
 *   spilledToAgent: boolean,
 *   stdinSpilled: boolean,
 *   spilledStdinTurns: number,
 *   droppedHistoryTurns: number,
 * }}
 */
export function foldConversationForAgy(messages, opts = {}) {
    const {
        userLabel = '',
        assistantLabel = '',
        cutoffMarker = AGY_CUTOFF_MARKER,
        useCutoff = true,
        abortOnOverflow = false,
        fallbackInstruction = DEFAULT_SYSTEM_INSTRUCTION,
        maxStdinBytes = AGY_MAX_STDIN_BYTES,
        maxTotalBytes = AGY_MAX_TOTAL_BYTES,
    } = opts;

    const list = (messages ?? []).filter((m) => m && typeof m === 'object' && typeof m.role === 'string');
    const markerStr = typeof cutoffMarker === 'string' && cutoffMarker.trim() ? cutoffMarker.trim() : null;
    const markerRe = useCutoff && markerStr ? new RegExp(escapeRegex(markerStr), 'i') : null;
    const stripMarkerRe = markerStr ? new RegExp(escapeRegex(markerStr), 'gi') : null;

    const hasCutoff = markerRe ? list.some((m) => markerRe.test(contentToText(m.content))) : false;

    // Identify the final non-system message so earlier messages with images get "[image omitted]".
    let lastNonSystemIdx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (m.role === 'system' || m.role === 'developer') continue;
        const cleaned = stripMarkerRe ? contentToText(m.content).replace(stripMarkerRe, '').trim() : contentToText(m.content).trim();
        if (cleaned || hasImage(m)) {
            lastNonSystemIdx = i;
            break;
        }
    }

    const formatBlockText = (rawText, role, includeOmitted) => {
        const text = String(rawText ?? '').trim();
        const omitted = includeOmitted ? '[image omitted]' : '';
        if (!text && !omitted) return '';
        const body = text && omitted ? `${text} ${omitted}` : (text || omitted);
        if (role === 'assistant') {
            return assistantLabel ? `${assistantLabel}: ${body}` : body;
        }
        if (role === 'user' || role === 'tool') {
            return userLabel ? `${userLabel}: ${body}` : body;
        }
        return body;
    };

    const agentBlocks = [];
    const stdinBlocks = [];
    let cutoffReached = !hasCutoff;

    for (let i = 0; i < list.length; i++) {
        const m = list[i];
        const isSystem = m.role === 'system' || m.role === 'developer';
        const includeOmitted = !isSystem && i !== lastNonSystemIdx && hasImage(m);
        const rawText = contentToText(m.content);

        if (!cutoffReached && markerRe && markerRe.test(rawText)) {
            const match = markerRe.exec(rawText);
            const beforeRaw = rawText.slice(0, match.index).replace(stripMarkerRe, '').trim();
            const afterRaw = rawText.slice(match.index + match[0].length).replace(stripMarkerRe, '').trim();
            cutoffReached = true;

            let omittedAttached = false;
            if (beforeRaw || (!afterRaw && includeOmitted)) {
                const formattedBefore = formatBlockText(beforeRaw, m.role, includeOmitted);
                omittedAttached = includeOmitted;
                if (formattedBefore) agentBlocks.push({ text: formattedBefore, isSystem });
            }
            if (afterRaw || (!omittedAttached && includeOmitted)) {
                const formattedAfter = formatBlockText(afterRaw, m.role, !omittedAttached && includeOmitted);
                if (formattedAfter) {
                    if (isSystem) agentBlocks.push({ text: formattedAfter, isSystem: true });
                    else stdinBlocks.push({ text: formattedAfter, isSystem: false });
                }
            }
            continue;
        }

        const cleanedText = stripMarkerRe ? rawText.replace(stripMarkerRe, '').trim() : rawText.trim();
        const formatted = formatBlockText(cleanedText, m.role, includeOmitted);
        if (!formatted) continue;

        if (!cutoffReached || isSystem) {
            agentBlocks.push({ text: formatted, isSystem });
        } else {
            stdinBlocks.push({ text: formatted, isSystem: false });
        }
    }

    // Empty stdin guard: move the last non-system block from agentBlocks into stdinBlocks, or fall back to "[Start]".
    if (stdinBlocks.length === 0) {
        let lastNonSysIdx = -1;
        for (let i = agentBlocks.length - 1; i >= 0; i--) {
            if (!agentBlocks[i].isSystem) {
                lastNonSysIdx = i;
                break;
            }
        }
        if (lastNonSysIdx !== -1) {
            const [moved] = agentBlocks.splice(lastNonSysIdx, 1);
            stdinBlocks.push(moved);
        } else {
            stdinBlocks.push({ text: '[Start]', isSystem: false });
        }
    }

    const joinBlocks = (blocks) => blocks.map((b) => b.text).join('\n\n');
    const sampleName = `${CHAT_AGENT_NAME}-000000-0000000000000-0000`;
    const buildSections = () => {
        const content = joinBlocks(agentBlocks);
        return content ? [{ heading: 'System_Instructions', content }] : [];
    };
    const totalSize = () => {
        const agentMd = buildChatAgentMd({ name: sampleName, sections: buildSections(), fallbackInstruction });
        return utf8Bytes(agentMd) + utf8Bytes(joinBlocks(stdinBlocks));
    };

    const initialStdinBytes = utf8Bytes(joinBlocks(stdinBlocks));
    const initialTotalBytes = totalSize();

    if (abortOnOverflow) {
        if (initialTotalBytes > maxTotalBytes) {
            throw Object.assign(
                new Error(
                    `Context overflow: total prompt size (${(initialTotalBytes / 1000).toFixed(1)} KB) exceeds Antigravity's ${(maxTotalBytes / 1000).toFixed(0)} KB ceiling. ` +
                    'Reduce context length in SillyTavern, or uncheck "Stop generation on context overflow" in the Subscriptions Gemini settings to allow dropping older turns.',
                ),
                { httpStatus: 400 },
            );
        }
        if (initialStdinBytes > maxStdinBytes) {
            throw Object.assign(
                new Error(
                    `STDIN overflow: chat turns routed to STDIN (${(initialStdinBytes / 1000).toFixed(1)} KB) exceed Antigravity's ${(maxStdinBytes / 1000).toFixed(0)} KB per-step limit. ` +
                    'Move <agy_cutoff> lower in your Prompt Manager, reduce chat history length, or uncheck "Stop generation on context overflow" in the Subscriptions Gemini settings to allow spilling older turns into agent.md.',
                ),
                { httpStatus: 400 },
            );
        }
    }

    // 180 KB stdin cap: spill oldest stdin blocks into the end of agentBlocks.
    let stdinSpilled = false;
    let spilledStdinTurns = 0;
    while (stdinBlocks.length > 1 && utf8Bytes(joinBlocks(stdinBlocks)) > maxStdinBytes) {
        agentBlocks.push(stdinBlocks.shift());
        stdinSpilled = true;
        spilledStdinTurns++;
    }
    if (stdinBlocks.length === 1 && utf8Bytes(stdinBlocks[0].text) > maxStdinBytes) {
        const { head, tail } = splitUtf8Tail(stdinBlocks[0].text, maxStdinBytes);
        if (head) {
            agentBlocks.push({ text: head, isSystem: stdinBlocks[0].isSystem });
            stdinSpilled = true;
            spilledStdinTurns++;
        }
        stdinBlocks[0] = { text: tail, isSystem: stdinBlocks[0].isSystem };
    }

    // 720 KB total cap: drop oldest non-system blocks first, then trim system blocks as a last resort.
    let droppedHistoryTurns = 0;
    while (totalSize() > maxTotalBytes) {
        const nonSysIdx = agentBlocks.findIndex((b) => !b.isSystem);
        if (nonSysIdx === -1) break;
        agentBlocks.splice(nonSysIdx, 1);
        droppedHistoryTurns++;
    }
    while (stdinBlocks.length > 1 && totalSize() > maxTotalBytes) {
        stdinBlocks.shift();
        droppedHistoryTurns++;
    }
    while (agentBlocks.length > 0 && totalSize() > maxTotalBytes) {
        const excess = totalSize() - maxTotalBytes;
        const lastIdx = agentBlocks.length - 1;
        const curBytes = utf8Bytes(agentBlocks[lastIdx].text);
        const target = Math.max(0, curBytes - excess - 32);
        if (target > 0) {
            const trimmed = sliceUtf8Head(agentBlocks[lastIdx].text, target).trimEnd();
            if (trimmed) {
                agentBlocks[lastIdx] = { ...agentBlocks[lastIdx], text: trimmed };
            } else {
                agentBlocks.pop();
            }
        } else {
            agentBlocks.pop();
        }
    }
    if (stdinBlocks.length === 1 && totalSize() > maxTotalBytes) {
        const excess = totalSize() - maxTotalBytes;
        const curBytes = utf8Bytes(stdinBlocks[0].text);
        const target = Math.max(0, curBytes - excess - 32);
        stdinBlocks[0] = { ...stdinBlocks[0], text: target > 0 ? splitUtf8Tail(stdinBlocks[0].text, target).tail : '' };
    }

    const prompt = joinBlocks(stdinBlocks);
    const agentSections = buildSections();
    return {
        prompt,
        agentSections,
        spilledToAgent: agentSections.length > 0,
        stdinSpilled,
        spilledStdinTurns,
        droppedHistoryTurns,
    };
}

/** Keys that clearly belong to another vendor (SillyTavern's Custom API key field is shared). */
export function isOtherVendorKey(key) {
    return isForeignKey('gemini', key);
}

/**
 * Key + base URL for the direct API backend. The base URL is paired with the
 * key's source, so a key never travels to an endpoint configured for another
 * one:
 *   ST_SUBSCRIPTIONS_GEMINI_BASE_URL          explicit override, any key
 *   GEMINI_API_KEY / GOOGLE_API_KEY (env)     GOOGLE_GEMINI_BASE_URL (env)
 *   agy settings.json env block               GOOGLE_GEMINI_BASE_URL from the same block
 *   Custom API key field / plugin key         Google's endpoint (set the override for anything else)
 * @param {import('express').Request|null} req
 * @param {{ settings?: object|null, env?: Record<string,string|undefined> }} [opts] test seams
 */
export function discoverGeminiApiCredentials(req, { settings = readAntigravitySettings(), env = process.env } = {}) {
    const pick = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
    const header = pick(bearerFromRequest(req));
    const candidates = [
        [header && !isOtherVendorKey(header) ? header : null, 'api-key-field'],
        [pick(env.ST_SUBSCRIPTIONS_GEMINI_API_KEY), 'ST_SUBSCRIPTIONS_GEMINI_API_KEY'],
        [pick(env.GEMINI_API_KEY), 'GEMINI_API_KEY'],
        [pick(env.GOOGLE_API_KEY), 'GOOGLE_API_KEY'],
        [pick(settings?.env?.GEMINI_API_KEY), 'antigravity-settings'],
    ];
    const hit = candidates.find(([key]) => key);
    if (!hit) return null;
    const [key, source] = hit;
    let baseUrl = pick(env.ST_SUBSCRIPTIONS_GEMINI_BASE_URL);
    if (!baseUrl) {
        if (source === 'antigravity-settings') baseUrl = pick(settings?.env?.GOOGLE_GEMINI_BASE_URL);
        else if (source === 'GEMINI_API_KEY' || source === 'GOOGLE_API_KEY') baseUrl = pick(env.GOOGLE_GEMINI_BASE_URL);
    }
    return { key, baseUrl: baseUrl || GOOGLE_OPENAI_COMPAT_BASE, source };
}

function mapAgyUsage(u) {
    if (!u) return null;
    return toOpenAiUsage({
        input: Math.max(0, (u.input_tokens ?? 0) - (u.cache_read_tokens ?? 0)),
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_tokens ?? 0,
        reasoning: u.thinking_tokens ?? 0,
    });
}

function errorType(err) {
    if (err?.httpStatus === 429) return 'rate_limit_error';
    return err?.httpStatus && err.httpStatus < 500 ? 'invalid_request_error' : 'server_error';
}

async function runViaAgy({ messages, model, settings, writer, signal, allowApiKey }) {
    const { currentMessage } = splitConversation(messages);
    if (hasImage(currentMessage)) {
        throw Object.assign(new Error('Images are not supported through the Antigravity CLI (agy) backend. Switch the Gemini backend to "API" to send images, or remove the image.'), { httpStatus: 400 });
    }
    const omitted = (messages ?? []).filter(hasImage).length;
    if (omitted) console.warn(`${TAG} agy takes text only: ${omitted} earlier message(s) with images sent as "[image omitted]"`);

    await listGeminiModels({ live: false });
    const resolved = resolveGeminiModel(model, settings.gemini.effort, geminiCatalog());
    const useCutoff = settings.gemini.useCutoff !== false;
    const abortOnOverflow = settings.gemini.abortOnOverflow !== false;
    const fallbackInstruction = settings.gemini.fallbackInstruction || DEFAULT_SYSTEM_INSTRUCTION;
    const stream = settings.gemini.stream !== false && writer.stream;

    const { prompt, agentSections, spilledToAgent, stdinSpilled, spilledStdinTurns, droppedHistoryTurns } = foldConversationForAgy(messages, {
        useCutoff,
        abortOnOverflow,
        fallbackInstruction,
    });
    if (stdinSpilled) {
        console.warn(`${TAG} STDIN exceeded 180 KB; spilled ${spilledStdinTurns} oldest STDIN turn(s) into agent.md`);
    }
    if (droppedHistoryTurns > 0) {
        console.warn(`${TAG} conversation exceeded agy's context ceiling; dropped ${droppedHistoryTurns} oldest history turn(s) so recent history and the current turn stay intact`);
    }
    const effortNote = resolved.agyEffort ? ` --effort ${resolved.agyEffort}` : (resolved.effort ? ` (effort ${resolved.effort})` : '');
    const spillNote = spilledToAgent ? ' (context partitioned into agent systemInstruction + STDIN)' : '';
    console.log(`${TAG} ${resolved.agyModel}${effortNote} via agy${allowApiKey ? ' (agy API-key mode)' : ''}${spillNote}`);

    const result = await runAgy({
        prompt,
        agentSections,
        fallbackInstruction,
        model: resolved.agyModel,
        effort: resolved.agyEffort,
        allowApiKey,
        stream,
        signal,
        onText: (delta) => writer.pushText(delta),
        onReasoning: settings.showReasoning ? (delta, opts) => writer.pushReasoning(delta, opts) : undefined,
    });
    if (signal?.aborted) throw abortError();
    writer.flushTail();
    writer.finish({ usage: mapAgyUsage(result?.usage) });
}

async function runViaDirectApi({ messages, model, settings, writer, signal, creds }) {
    const resolved = resolveGeminiModel(model, settings.gemini.effort, undefined, { forAgy: false });
    const extraBody = {};
    if (resolved.effort) extraBody.reasoning_effort = resolved.effort;
    if (settings.maxTokens) extraBody.max_tokens = settings.maxTokens;
    if (settings.temperature !== undefined) extraBody.temperature = settings.temperature;
    if (settings.topP !== undefined) extraBody.top_p = settings.topP;
    if (settings.stops.length) extraBody.stop = settings.stops.slice(0, 4);
    let host = creds.baseUrl;
    try { host = new URL(creds.baseUrl).host; } catch { /* not a URL */ }
    // Google's endpoint knows bare ids only; other endpoints get the id as routed (google/… kept).
    const apiModel = host === GOOGLE_HOST ? agyModelId(resolved.apiModel) : resolved.apiModel;
    console.log(`${TAG} ${apiModel} via direct API (${creds.source} → ${host}${resolved.effort ? `, effort ${resolved.effort}` : ''})`);
    await runOpenAiCompat({ baseUrl: creds.baseUrl, apiKey: creds.key, model: apiModel, messages, extraBody, writer, signal, tag: TAG });
}

/**
 * @param {object} args
 * @param {import('express').Request} args.req
 * @param {object[]} args.messages
 * @param {string} args.model requested model id
 * @param {object} args.settings from extractRequestSettings()
 * @param {import('../common/completion.js').CompletionWriter} args.writer
 * @param {AbortSignal} [args.signal] aborted when the client disconnects or the plugin stops
 */
export async function runGeminiChat({ req, messages, model, settings, writer, signal }) {
    const backend = settings.gemini.backend;
    const cliAvailable = !!agyLaunchSpec();
    try {
        if (backend === 'api') {
            const creds = discoverGeminiApiCredentials(req);
            if (!creds) throw Object.assign(new Error('Gemini backend "API" selected but no key found: set GEMINI_API_KEY (plus GOOGLE_GEMINI_BASE_URL for a compatible endpoint), or paste the key into SillyTavern\'s Custom API key field (plus ST_SUBSCRIPTIONS_GEMINI_BASE_URL for a non-Google endpoint).'), { httpStatus: 400 });
            return await runViaDirectApi({ messages, model, settings, writer, signal, creds });
        }
        if (backend === 'subscription') {
            if (!cliAvailable) throw Object.assign(new Error('Antigravity CLI (agy) not found: install it from https://antigravity.google/cli and sign in by running `agy` once, or switch the Gemini backend to "API".'), { httpStatus: 400 });
            const billing = agyBilling();
            if (billing.subscriptionBlocked) throw Object.assign(new Error(billing.reason), { httpStatus: 400 });
            return await runViaAgy({ messages, model, settings, writer, signal, allowApiKey: false });
        }
        // auto: agy as it is configured; the API backend only without agy.
        if (cliAvailable) return await runViaAgy({ messages, model, settings, writer, signal, allowApiKey: agyBilling().apiKeyMode });
        const creds = discoverGeminiApiCredentials(req);
        if (creds) return await runViaDirectApi({ messages, model, settings, writer, signal, creds });
        throw Object.assign(new Error('Neither the Antigravity CLI (agy) nor a Gemini API key is available. Install agy and sign in, or set GEMINI_API_KEY.'), { httpStatus: 400 });
    } catch (err) {
        // Client gone or plugin stopping: nothing to send; the listener ends the response.
        if (signal?.aborted) return;
        console.error(`${TAG} request failed:`, err instanceof Error ? err.message : err);
        writer.fail(err, { status: err?.httpStatus ?? 500, type: errorType(err) });
    }
}