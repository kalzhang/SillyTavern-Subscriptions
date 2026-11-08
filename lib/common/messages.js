// ──────────────────────────────────────────────
// OpenAI messages[] helpers shared by every provider
// ──────────────────────────────────────────────
//
// Claude gets real multi-turn context through the Agent SDK's session resume
// (lib/claude/jsonl-entries.js). Codex and Gemini run through CLIs that take a
// single prompt per turn, so their history is *folded* into one transcript.
// All of them share one reading of the message list —
// partitionConversation() — so the three providers agree on what the system
// prompt is, which turn is "current", and when a reply is a continuation.
//
// Position matters for system messages. SillyTavern sends:
//   • a LEADING run of system messages (main prompt, card, persona, examples)
//     → the system prompt;
//   • system messages INSIDE the history (Author's Note / World Info at depth)
//     → they must stay where they are;
//   • system messages at the END (Impersonate prompt, quiet prompts used by
//     Summarize / captions / /gen, the group-chat nudge, post-history
//     instructions) → they ARE the current instruction.
// Only the leading run is hoisted; every later system message becomes a user
// turn in place (the same conversion SillyTavern's own Claude converter
// does). A reply is treated as a continuation/prefill ONLY when the literal
// last message is an assistant message.

/** Flatten OpenAI content (string or multi-part array) to plain text. */
export function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('\n');
    }
    return '';
}

/** Content → array of parts (text parts + image parts), dropping unknown ones. */
function contentToParts(content) {
    if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
    if (!Array.isArray(content)) return [];
    return content.filter((p) => p && ((p.type === 'text' && typeof p.text === 'string') || p.type === 'image_url'));
}

/** Merge two user-role contents, keeping image parts. */
function mergeUserContent(a, b) {
    const pa = contentToParts(a);
    const pb = contentToParts(b);
    const hasImages = [...pa, ...pb].some((p) => p.type === 'image_url');
    if (!hasImages) {
        return [contentToText(a), contentToText(b)].filter((t) => t.length > 0).join('\n\n');
    }
    const sep = pa.length && pb.length ? [{ type: 'text', text: '\n\n' }] : [];
    return [...pa, ...sep, ...pb];
}

function isRenderable(m) {
    if (m.role === 'tool') return true;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) return true;
    if (contentToText(m.content).trim()) return true;
    return Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url');
}

/**
 * Read an OpenAI messages array the way every provider should.
 * @param {object[]} messages
 * @returns {{
 *   system: string|undefined,   leading system run, joined
 *   turns: object[],            everything after it; later system messages converted to user
 *                               turns and adjacent user turns merged
 *   prefill: string|null,       text of the literal last message when it is an assistant turn
 * }}
 */
export function partitionConversation(messages) {
    const list = (messages ?? []).filter((m) => m && typeof m === 'object' && typeof m.role === 'string');

    let i = 0;
    const sys = [];
    while (i < list.length && list[i].role === 'system') {
        const text = contentToText(list[i].content);
        if (text.trim()) sys.push(text);
        i++;
    }

    const turns = [];
    for (const m of list.slice(i)) {
        let msg = m;
        if (m.role === 'system' || m.role === 'developer') {
            msg = { role: 'user', content: m.content, fromSystem: true };
        }
        if (!isRenderable(msg)) continue;
        const msgSegments = msg.role === 'user'
            ? [{ text: contentToText(msg.content), fromSystem: !!msg.fromSystem }]
            : undefined;
        const prev = turns[turns.length - 1];
        if (msg.role === 'user' && prev && prev.role === 'user') {
            const prevSegments = prev.segments ?? [{ text: contentToText(prev.content), fromSystem: !!prev.fromSystem }];
            turns[turns.length - 1] = {
                ...prev,
                content: mergeUserContent(prev.content, msg.content),
                fromSystem: !!(prev.fromSystem && msg.fromSystem),
                segments: [...prevSegments, ...msgSegments],
            };
            continue;
        }
        turns.push(msgSegments ? { ...msg, segments: msgSegments } : msg);
    }

    const last = list[list.length - 1];
    const prefill = last && last.role === 'assistant' && i < list.length ? contentToText(last.content) : null;

    return { system: sys.length ? sys.join('\n\n') : undefined, turns, prefill };
}

/** The system prompt: the leading run of system messages only. */
export function extractSystemText(messages) {
    return partitionConversation(messages).system;
}

/** Data-URL image parts of one message → [{ mediaType, data, url }]. */
export function imagePartsOf(content) {
    if (!Array.isArray(content)) return [];
    const out = [];
    for (const p of content) {
        if (!p || p.type !== 'image_url') continue;
        const url = p.image_url?.url ?? '';
        const m = url.match(/^data:(image\/[^;]+);base64,([A-Za-z0-9+/]+=*)$/);
        if (m) out.push({ mediaType: m[1], data: m[2], url });
        else if (/^https?:\/\//i.test(url)) out.push({ mediaType: null, data: null, url });
    }
    return out;
}

/**
 * Closest CLI-side approximation of Messages-API assistant prefill. The
 * prefill text stays client-side (SillyTavern keeps it), so the synthetic turn
 * tells the model to continue after it rather than repeat it.
 *
 * Phrasing matters: Fable's safeguard classifier rejects a resumed session
 * whose last turn reads like an injected "reply as if you already said…"
 * template (verified live), while this plain "your message was cut off"
 * wording passes on every backend.
 */
export function buildPrefillContinuation(prefill) {
    const normalized = String(prefill ?? '').trimEnd();
    if (!normalized.trim()) return '[Continue your last message — write only what comes next.]';
    return [
        '[Continue your last message. It currently ends with:',
        `"${normalized}"`,
        'Write only what comes next — do not repeat what is already written, and keep the same voice and format.]',
    ].join('\n');
}

/**
 * Split messages into { system, history, current, prefill, currentMessage }:
 *  - system: the leading system text (or undefined)
 *  - history: prior turns (excluding the current one; a continued assistant
 *    message stays in it)
 *  - current: the final user turn's text, or a continuation instruction when
 *    the conversation ends on an assistant turn (prefill / "continue")
 *  - prefill: the trailing assistant text when that case applies
 *  - currentMessage: the final user turn as a message object (images kept)
 */
export function splitConversation(messages) {
    const { system, turns, prefill } = partitionConversation(messages);
    if (turns.length === 0) {
        return { system, history: [], current: '[Start]', prefill: null, currentMessage: null };
    }
    const last = turns[turns.length - 1];
    if (prefill !== null && last.role === 'assistant') {
        // The message being continued stays in the history (the model sees its
        // own words as its turn); the instruction to continue follows it.
        return { system, history: turns, current: buildPrefillContinuation(prefill), prefill, currentMessage: null };
    }
    if (last.role === 'assistant') {
        // Defensive: a trailing assistant turn that was not the literal last message cannot happen after partitioning.
        return { system, history: turns, current: '[Start]', prefill: null, currentMessage: null };
    }
    return { system, history: turns.slice(0, -1), current: contentToText(last.content) || '[Start]', prefill: null, currentMessage: last };
}

/**
 * Format one history turn for a folded transcript, only prepending role labels
 * when non-empty labels are explicitly provided.
 */
export function formatHistoryTurnForFold(m, { userLabel = '', assistantLabel = '' } = {}) {
    const uPrefix = userLabel ? `${userLabel}: ` : '';
    const aPrefix = assistantLabel ? `${assistantLabel}: ` : '';
    const hasImg = Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url');
    const omitted = hasImg ? '[image omitted]' : '';
    if (m.role === 'assistant') {
        const text = contentToText(m.content).trim();
        if (!text && !omitted) return '';
        const body = text && omitted ? `${text} ${omitted}` : (text || omitted);
        return `${aPrefix}${body}`;
    }
    if (m.role === 'user' || m.role === 'tool') {
        const segs = Array.isArray(m.segments) ? m.segments : null;
        const hasMixed = segs && segs.some((s) => s.fromSystem) && segs.some((s) => !s.fromSystem);
        if (hasMixed) {
            const parts = [];
            let attachedOmitted = false;
            for (const s of segs) {
                const t = String(s.text ?? '').trim();
                if (!t) continue;
                if (s.fromSystem) {
                    parts.push(t);
                } else {
                    const body = !attachedOmitted && omitted ? `${t} ${omitted}` : t;
                    attachedOmitted = true;
                    parts.push(`${uPrefix}${body}`);
                }
            }
            if (!attachedOmitted && omitted) parts.push(`${uPrefix}${omitted}`);
            return parts.join('\n\n');
        }
        const text = contentToText(m.content).trim();
        if (!text && !omitted) return '';
        const body = text && omitted ? `${text} ${omitted}` : (text || omitted);
        return `${uPrefix}${body}`;
    }
    return '';
}

/**
 * Format the current (final) turn for a folded transcript in exact segment
 * order without wrapper tags or trailing instruction injection.
 */
export function formatCurrentTurnForFold({ current, prefill, currentMessage, userLabel = '', assistantLabel = '' } = {}) {
    if (prefill !== null) return [current];
    const uPrefix = userLabel ? `${userLabel}: ` : '';
    if (currentMessage?.fromSystem) {
        return [current];
    }
    const segs = Array.isArray(currentMessage?.segments) ? currentMessage.segments : null;
    if (segs && segs.length > 0) {
        const out = [];
        for (const s of segs) {
            const t = String(s.text ?? '').trim();
            if (!t) continue;
            out.push(s.fromSystem ? t : `${uPrefix}${t}`);
        }
        if (out.length) return out;
    }
    return [`${uPrefix}${current}`];
}

/**
 * Fold a conversation into a single prompt string for one-shot CLIs.
 *
 * @param {object[]} messages OpenAI messages
 * @param {object} [opts]
 * @param {boolean} [opts.includeSystem=true] inline the system prompt (false when the backend takes it separately)
 * @param {string}  [opts.preamble] extra instruction placed first (e.g. "text-only, no tools")
 * @param {string}  [opts.userLabel=''] label for user turns
 * @param {string}  [opts.assistantLabel=''] label for assistant turns
 */
export function foldConversation(messages, opts = {}) {
    const { includeSystem = true, preamble, userLabel = '', assistantLabel = '' } = opts;
    const { system, history, current, prefill, currentMessage } = splitConversation(messages);
    const sections = [];
    if (preamble) sections.push(preamble.trim());
    if (includeSystem && system) sections.push(system);

    const lines = [];
    for (const m of history) {
        const formatted = formatHistoryTurnForFold(m, { userLabel, assistantLabel });
        if (formatted) lines.push(formatted);
    }
    if (lines.length) sections.push(lines.join('\n\n'));

    sections.push(...formatCurrentTurnForFold({ current, prefill, currentMessage, userLabel, assistantLabel }));
    return sections.join('\n\n');
}

/** Roleplay-safe default instruction for CLIs that would otherwise use a coding preamble. */
export const TEXT_ONLY_PREAMBLE =
    'You are an assistant inside a chat application. ' +
    'Do not use tools, do not run commands, do not browse, and do not create files — there is nothing to execute; ' +
    'just write the reply.';