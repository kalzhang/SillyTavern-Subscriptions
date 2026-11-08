// agy 1.4.1/1.4.2/1.4.10 can retain a filtered attempt's error after a later normal reply.
// Verify the exact request's persisted steps; never recover the filtered text.
// Protocol evidence and tradeoffs: .agents/notes/implemented/bug-fix/2026-10-18-gemini-verified-retry.md
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAYLOAD = 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
let sqlite;

function varint(bytes, cursor) {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
        if (cursor.pos >= bytes.length) throw new Error('truncated protobuf varint');
        const byte = bytes[cursor.pos++];
        value |= BigInt(byte & 127) << BigInt(7 * i);
        if (!(byte & 128)) {
            if (i === 9 && byte > 1) throw new Error('invalid protobuf varint');
            return value;
        }
    }
    throw new Error('invalid protobuf varint');
}

function fields(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_PAYLOAD) throw new Error('invalid step payload size');
    const result = new Map();
    const cursor = { pos: 0 };
    while (cursor.pos < bytes.length) {
        const tag = varint(bytes, cursor);
        const number = Number(tag >> 3n);
        const wire = Number(tag & 7n);
        if (!number || number > 0x1fffffff) throw new Error('invalid protobuf field');
        let value;
        if (wire === 0) value = varint(bytes, cursor);
        else {
            const length = wire === 2 ? Number(varint(bytes, cursor)) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
            if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - cursor.pos) throw new Error('invalid protobuf length or wire type');
            value = bytes.subarray(cursor.pos, cursor.pos + length);
            cursor.pos += length;
        }
        const values = result.get(number) ?? [];
        values.push({ wire, value });
        result.set(number, values);
    }
    return result;
}

function single(message, number, wire, optional = false) {
    const values = message.get(number);
    if (!values && optional) return undefined;
    if (values?.length !== 1 || values[0].wire !== wire) throw new Error('unexpected protobuf schema');
    return values[0].value;
}

export function decodeTrajectoryStep(row) {
    const step = fields(row.step_payload);
    if (row.step_format !== 0 || single(step, 1, 0) !== BigInt(row.step_type) || single(step, 4, 0) !== BigInt(row.status)) {
        throw new Error('step identity differs from payload');
    }
    if (single(step, 31, 2, true) || row.error_details) throw new Error('step has additional error details');
    if (row.step_type === 15) {
        const reply = fields(single(step, 20, 2));
        if (reply.has(7)) throw new Error('response includes tool calls');
        const text = utf8.decode(single(reply, 1, 2));
        const modified = single(reply, 8, 2, true);
        return {
            index: row.idx,
            text: modified ? utf8.decode(modified) : text,
            stopReason: Number(single(reply, 12, 0)),
        };
    }
    if (row.step_type === 17) {
        // CortexStepErrorMessage.error (3) -> CortexError.short_error (2).
        const error = fields(single(step, 24, 2));
        const detail = fields(single(error, 3, 2));
        return { index: row.idx, error: utf8.decode(single(detail, 2, 2)) };
    }
    throw new Error('unsupported trajectory step');
}

function inspect(db, { conversationId, lastTextStep, lastErrorStep, expectedText, errorText }) {
    const owner = db.prepare('SELECT cascade_id FROM trajectory_meta').all();
    if (owner.length !== 1 || owner[0].cascade_id !== conversationId) return { ok: false, reason: 'conversation-mismatch' };
    const rows = db.prepare('SELECT idx, step_type, status, step_format, length(step_payload) AS size FROM steps ORDER BY idx LIMIT 129').all();
    if (!rows.length || rows.length > 128 || rows.some((r) => r.status !== 3)) return { ok: false, reason: 'trajectory-not-complete', pending: true };
    // Recovery is only for the observed input -> response/error retries.
    // Completed tool or unknown steps do not establish text-only success.
    if (rows[0].step_type !== 14 || rows.slice(1).some((r) => ![15, 17].includes(r.step_type))) {
        return { ok: false, reason: 'unexpected-trajectory-step' };
    }
    const last = rows.at(-1);
    if (last.idx !== lastTextStep || last.step_type !== 15) return { ok: false, reason: 'later-or-different-step' };
    const errorIndex = rows.findIndex((r) => r.idx === lastErrorStep && r.step_type === 17);
    if (errorIndex < 1 || lastErrorStep >= lastTextStep || rows.slice(errorIndex + 1).some((r) => r.step_type === 17)) {
        return { ok: false, reason: 'error-order-mismatch' };
    }
    const query = db.prepare('SELECT idx, step_type, status, step_format, error_details, step_payload FROM steps WHERE idx=?');
    const decode = (row) => {
        if (!row.size || row.size > MAX_PAYLOAD) throw new Error('step payload exceeds limit');
        return decodeTrajectoryStep(query.get(row.idx));
    };
    // With several retries the terminal error can refer to an earlier attempt,
    // not necessarily the last error event. It must still match a filtered one.
    let matched = null;
    for (let i = 1; i <= errorIndex; i++) {
        if (rows[i].step_type !== 17 || rows[i - 1].step_type !== 15) continue;
        const error = decode(rows[i]);
        if (!error.error.trim() || (errorText !== null && error.error.trim() !== errorText.trim())) continue;
        if (decode(rows[i - 1]).stopReason === 11) matched = error;
    }
    if (!matched) return { ok: false, reason: 'no-matching-filter-error' };
    const after = decode(last);
    if (after.stopReason !== 2 || !after.text.trim()) return { ok: false, reason: 'retry-not-normal' };
    // agy 1.4.2 adds one LF in its DONE text_delta, outside the stored reply.
    // Accept only that exact framing difference; never trim or rewrite content.
    if (after.text !== expectedText && after.text + '\n' !== expectedText) return { ok: false, reason: 'reply-differs-from-events' };
    return { ok: true, response: after.text, stepIndex: after.index, errorStep: matched.index, stopReason: after.stopReason };
}

/**
 * A bounded, read-only exception for the tested stale-filter-error versions.
 * Unknown versions/runtime/schema keep the original failure; no model is retried.
 */
export async function verifyAgyRetry({
    version, conversationId, lastTextStep, lastErrorStep, expectedText, errorText, signal, terminalStatus = 'ERROR',
    directory = join(homedir(), '.gemini', 'antigravity-cli', 'conversations'),
    waitMs = 1500,
}) {
    if (!['1.4.1', '1.4.2', '1.4.10'].includes(version)) return { ok: false, reason: 'unsupported-agy-version' };
    if (!UUID.test(conversationId ?? '') || !Number.isSafeInteger(lastTextStep) || !Number.isSafeInteger(lastErrorStep)
        || lastTextStep <= lastErrorStep || !expectedText
        || !(typeof errorText === 'string' || (errorText === null && terminalStatus === 'SUCCESS'))) {
        return { ok: false, reason: 'missing-request-identity' };
    }
    // readOnly was not available in the first experimental node:sqlite builds.
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (!(major >= 24 || (major === 22 && minor >= 13))) return { ok: false, reason: 'sqlite-unavailable' };
    let DatabaseSync;
    try {
        sqlite ??= import('node:sqlite');
        ({ DatabaseSync } = await sqlite);
    } catch {
        return { ok: false, reason: 'sqlite-unavailable' };
    }
    const path = join(directory, conversationId + '.db');
    const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 2000);
    let outcome = { ok: false, reason: 'database-not-written', pending: true };
    do {
        if (signal?.aborted) return { ok: false, reason: 'aborted' };
        if (existsSync(path)) {
            let db;
            try {
                db = new DatabaseSync(path, { readOnly: true });
                db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=25; BEGIN');
                outcome = inspect(db, { conversationId, lastTextStep, lastErrorStep, expectedText, errorText });
            } catch (err) {
                // SQLite/schema/protobuf are the untrusted boundary. Keep a
                // machine-readable reason, not the SQL, payload or reply text.
                outcome = { ok: false, reason: 'trajectory-read-failed', failureType: err.code ?? err.name, pending: [5, 6].includes(err.errcode) };
            } finally {
                db?.close();
            }
            if (outcome.ok || !outcome.pending) return outcome;
        }
        if (Date.now() >= deadline) break;
        await delay(Math.min(50, Math.max(0, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return outcome;
}
