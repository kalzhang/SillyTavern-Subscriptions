// ──────────────────────────────────────────────
// CompletionWriter — one output path for every provider
// ──────────────────────────────────────────────
//
// Providers push text / reasoning deltas into a writer; the writer decides
// whether that becomes SSE chunks (stream=true) or an accumulated JSON reply,
// applies server-side stop sequences, and renders errors in whichever mode
// the client is in (an SSE stream that has already started must end with an
// error event + [DONE], never a 500).
//
// The writer never touches a response that has already ended or whose socket
// is gone: in Node a write() after end() is emitted as an 'error' event on the
// response, and with no listener that is an uncaught exception — which would
// take SillyTavern (our host process) down with it.

import { StopScanner } from './stops.js';
import { makeCompletionId, writeSse, writeDone, writeComment, chunkShell, roleChunk, contentChunk, reasoningChunk, finishChunk, errorEvent } from './sse.js';

/** Leading decoration stripped from BOTH the prefill and the model output before comparing. */
const PREFILL_LEAD_RE = /^[\s"'“”‘’*_]+/;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

/** Case-insensitive "a equals b" compared one UTF-16 unit at a time (no length drift from toLowerCase). */
function sameIgnoringCase(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i] && a[i].toLowerCase() !== b[i].toLowerCase()) return false;
    }
    return true;
}

export const HEARTBEAT_MS = 15000;

export class CompletionWriter {
    #res;
    #stream;
    #shell;
    #scanner;
    #showReasoning;
    #sseStarted = false;
    #ended = false;
    #sawReasoningDeltas = false;
    #heartbeat = null;

    #prefill = null;
    #prefillBuf = '';
    #prefillPending = false;

    text = '';
    reasoning = '';
    finishReason = 'stop';
    usage = null;
    stopMatched = false;
    /** true once anything visible reached the client (no retries after this) */
    didYieldContent = false;
    /** set when a prefill echo was stripped from the reply */
    strippedPrefill = false;

    /**
     * @param {object} args
     * @param {import('express').Response} args.res
     * @param {boolean} args.stream
     * @param {string} args.model model id echoed back to the client
     * @param {string[]} [args.stops]
     * @param {boolean} [args.showReasoning=true]
     * @param {string} [args.idPrefix]
     */
    constructor({ res, stream, model, stops = [], showReasoning = true, idPrefix = 'chatcmpl' }) {
        this.#res = res;
        this.#stream = stream;
        this.#showReasoning = showReasoning;
        this.id = makeCompletionId(idPrefix);
        this.created = Math.floor(Date.now() / 1000);
        this.model = model;
        this.#shell = chunkShell(this.id, this.created, model);
        this.#scanner = new StopScanner(stops);
    }

    get stream() { return this.#stream; }
    get sseStarted() { return this.#sseStarted; }
    get ended() { return this.#ended; }
    get showReasoning() { return this.#showReasoning; }

    /** The response can no longer be written to (ended by anyone, or the socket is gone). */
    #closed() {
        return !!(this.#res.writableEnded || this.#res.destroyed);
    }

    /** writeSse, but never after the response ended or the client left. */
    #send(payload) {
        if (this.#closed()) return false;
        writeSse(this.#res, payload);
        return true;
    }

    /** One JSON response (Express's res.status().json() when present, plain Node otherwise). */
    #sendJson(status, payload) {
        const res = this.#res;
        if (typeof res.status === 'function' && typeof res.json === 'function') {
            res.status(status).json(payload);
            return;
        }
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
    }

    /** A write that failed although the socket looked alive is worth a log line, not a crash. */
    #writeFailed(err) {
        if (!this.#closed()) console.warn(`[subscriptions] could not write the reply: ${err instanceof Error ? err.message : err}`);
    }

    /** Fresh stop scanner for a retry attempt (held-back text must not leak). */
    resetScanner(stops) {
        this.#scanner = new StopScanner(stops ?? []);
        this.stopMatched = false;
        if (this.#prefill) { this.#prefillBuf = ''; this.#prefillPending = true; }
    }

    /**
     * Assistant prefill ("Start Reply With" / Continue) that SillyTavern keeps
     * client-side. CLI backends can only be *asked* not to repeat it; when a
     * model echoes it anyway the echo is stripped so the message is not
     * duplicated. Output is held back only while it still reads as a prefix of
     * the prefill — for Continue that can be the whole last message, so a
     * genuine continuation is released at its first differing character.
     *
     * Both sides are compared with leading whitespace, quotes and * / _
     * removed (roleplay messages usually open with *action* or "dialogue"),
     * case-insensitively, and an echo only counts when it ends on a word
     * boundary: prefill "The" must not eat the start of "theater".
     */
    setPrefill(prefill) {
        const p = String(prefill ?? '').trim().replace(PREFILL_LEAD_RE, '');
        if (!p) return;
        this.#prefill = p;
        this.#prefillBuf = '';
        this.#prefillPending = true;
    }

    /** Stop deciding: hand back everything held so far, untouched. */
    #releasePrefillBuf() {
        this.#prefillPending = false;
        const out = this.#prefillBuf;
        this.#prefillBuf = '';
        return out;
    }

    /** Route a delta through the prefill-echo filter; returns text to scan for stops. */
    #filterPrefill(delta) {
        if (!this.#prefillPending) return delta;
        this.#prefillBuf += delta;
        const lead = this.#prefillBuf.replace(PREFILL_LEAD_RE, '');
        const want = this.#prefill;
        if (lead.length <= want.length) {
            // Still a prefix of the prefill → could be an echo, keep holding.
            if (sameIgnoringCase(lead, want.slice(0, lead.length))) return '';
            return this.#releasePrefillBuf();
        }
        if (!sameIgnoringCase(lead.slice(0, want.length), want)) return this.#releasePrefillBuf();
        // Matched, but "The" + "ater" is a new word, not an echo.
        if (WORD_CHAR_RE.test(want.charAt(want.length - 1)) && WORD_CHAR_RE.test(lead.charAt(want.length))) {
            return this.#releasePrefillBuf();
        }
        // Echo confirmed: emit only what follows it (whitespace included —
        // SillyTavern appends the reply straight after the prefill text).
        this.#prefillPending = false;
        this.#prefillBuf = '';
        this.strippedPrefill = true;
        return lead.slice(want.length);
    }

    /** @returns {boolean} true when SSE output may be written */
    #startSse() {
        if (!this.#stream) return false;
        if (this.#sseStarted) return !this.#closed();
        if (this.#closed()) return false;
        this.#sseStarted = true;
        if (!this.#res.headersSent) {
            this.#res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            this.#res.setHeader('Cache-Control', 'no-cache, no-transform');
            this.#res.setHeader('Connection', 'keep-alive');
            this.#res.setHeader('X-Accel-Buffering', 'no');
            if (typeof this.#res.flushHeaders === 'function') this.#res.flushHeaders();
        }
        writeSse(this.#res, roleChunk(this.#shell));
        return true;
    }

    /**
     * Streaming only: send the SSE headers now and an SSE comment every `ms`
     * until the reply ends. Reverse proxies and tunnels in front of
     * SillyTavern (nginx 60 s, Cloudflare 100 s) drop a request that shows no
     * first byte, and hidden reasoning can take minutes. Comment lines are
     * ignored by SillyTavern's SSE reader, and an error after this point is
     * still delivered (as an SSE error event).
     */
    startHeartbeat(ms = HEARTBEAT_MS) {
        if (!this.#stream || this.#ended || this.#heartbeat) return;
        if (!this.#startSse()) return;
        this.#heartbeat = setInterval(() => {
            if (this.#ended || this.#closed()) { this.#stopHeartbeat(); return; }
            // A throw inside a timer callback would be uncaught (fatal for the host).
            try { writeComment(this.#res, 'keep-alive'); } catch (err) { this.#stopHeartbeat(); this.#writeFailed(err); }
        }, Math.max(1, ms));
        this.#heartbeat.unref?.();
    }

    #stopHeartbeat() {
        if (this.#heartbeat) { clearInterval(this.#heartbeat); this.#heartbeat = null; }
    }

    /** Push a visible-text delta through the stop scanner. Returns true when a stop matched. */
    pushText(delta) {
        if (this.#ended || this.stopMatched || !delta) return this.stopMatched;
        delta = this.#filterPrefill(delta);
        if (!delta) return false;
        const { emit, matched } = this.#scanner.feed(delta);
        if (emit) this.#emitText(emit);
        if (matched) {
            this.stopMatched = true;
            this.finishReason = 'stop';
        }
        return matched;
    }

    #emitText(text) {
        if (this.#ended) return;
        this.didYieldContent = true;
        this.text += text;
        if (this.#stream && this.#startSse()) this.#send(contentChunk(this.#shell, text));
    }

    /** Push a reasoning/thinking delta (dropped when reasoning display is off). */
    pushReasoning(delta, { isDelta = true } = {}) {
        if (this.#ended || !delta || !this.#showReasoning) return;
        if (isDelta) this.#sawReasoningDeltas = true;
        // A complete thinking block arriving after deltas already streamed it is a duplicate.
        else if (this.#sawReasoningDeltas) return;
        this.didYieldContent = true;
        this.reasoning += delta;
        if (this.#stream && this.#startSse()) this.#send(reasoningChunk(this.#shell, delta));
    }

    /** Flush held-back text (call once generation ended without a stop match). */
    flushTail() {
        if (this.#ended || this.stopMatched) return;
        if (this.#prefillPending) {
            // Stream ended while still deciding — the model wrote a prefix of the
            // prefill (or nothing). Emit it verbatim unless it IS the prefill.
            const held = this.#releasePrefillBuf();
            const lead = held.replace(PREFILL_LEAD_RE, '');
            if (held && !sameIgnoringCase(lead, this.#prefill)) {
                const { emit } = this.#scanner.feed(held);
                if (emit) this.#emitText(emit);
            } else if (held) {
                this.strippedPrefill = true;
            }
        }
        const tail = this.#scanner.flush();
        if (tail) this.#emitText(tail);
    }

    /** Finish successfully. */
    finish({ usage = null, finishReason } = {}) {
        if (this.#ended) return;
        this.#ended = true;
        this.#stopHeartbeat();
        if (usage) this.usage = usage;
        if (finishReason) this.finishReason = finishReason;
        if (this.#closed()) return; // client gone — nothing to deliver
        try {
            if (this.#stream) {
                if (!this.#startSse()) return; // headers even for instant empty results
                this.#send(finishChunk(this.#shell, this.finishReason, this.usage ?? undefined));
                writeDone(this.#res);
                this.#res.end();
                return;
            }
            const message = { role: 'assistant', content: this.text };
            if (this.reasoning) message.reasoning_content = this.reasoning;
            const response = {
                id: this.id,
                object: 'chat.completion',
                created: this.created,
                model: this.model,
                choices: [{ index: 0, message, finish_reason: this.finishReason }],
            };
            if (this.usage) response.usage = this.usage;
            if (this.#res.headersSent) { this.#res.end(); return; }
            this.#sendJson(200, response);
        } catch (writeErr) { this.#writeFailed(writeErr); }
    }

    /** Fail. Streams that already started get an SSE error event; otherwise a JSON error. */
    fail(err, { status = 500, type = 'server_error' } = {}) {
        if (this.#ended) return;
        this.#ended = true;
        this.#stopHeartbeat();
        if (this.#closed()) return; // client gone — nobody to tell
        const message = err instanceof Error ? err.message : String(err);
        const payload = errorEvent(message, type);
        if (typeof err?.partialResponse === 'string' && err.partialResponse) {
            payload.partial_response = { content: err.partialResponse, incomplete: true };
        }
        try {
            if (this.#stream && this.#sseStarted) {
                this.#send(payload);
                writeDone(this.#res);
                this.#res.end();
                return;
            }
            if (this.#res.headersSent) { this.#res.end(); return; }
            // SillyTavern's backend shows only the HTTP reason phrase of a
            // failed non-streaming Custom request, not the JSON body — so the
            // message goes there too (latin1 printable only, or Node throws).
            if (status >= 400) {
                const phrase = String(message).replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
                if (phrase) { try { this.#res.statusMessage = phrase; } catch { /* keep the default phrase */ } }
            }
            this.#sendJson(status, payload);
        } catch (writeErr) { this.#writeFailed(writeErr); }
    }
}
