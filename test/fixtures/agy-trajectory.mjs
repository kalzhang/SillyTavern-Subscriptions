// Synthetic, non-sensitive replay of the 1.4.1 schema. Never copies a real chat.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* optional on Node 18/20 */ }
export const hasSqlite = !!DatabaseSync;
export const ID = '11111111-1111-4111-8111-111111111111';
export const SAFETY_ERROR = 'Your previous response was blocked by content safety filters: synthetic test case';
export const FIRST_TEXT = 'Rejected draft';
export const LAST_TEXT = 'Safe revised answer';

function integer(n) {
    const bytes = [];
    do { bytes.push((n & 127) | (n > 127 ? 128 : 0)); n >>>= 7; } while (n);
    return Buffer.from(bytes);
}
function field(number, value) {
    if (typeof value === 'number') return Buffer.concat([integer(number * 8), integer(value)]);
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    return Buffer.concat([integer(number * 8 + 2), integer(bytes.length), bytes]);
}
export function replyPayload({ type = 15, status = 3, text = LAST_TEXT, stopReason = 2, tools = false } = {}) {
    const body = Buffer.concat([field(1, text), field(8, text), field(12, stopReason), ...(tools ? [field(7, Buffer.alloc(0))] : [])]);
    return Buffer.concat([field(1, type), field(4, status), field(20, body)]);
}
function errorPayload(text = SAFETY_ERROR) {
    const detail = Buffer.concat([field(2, text), field(6, 'synthetic-content-filter')]);
    const error = Buffer.concat([field(3, detail), field(4, 1)]);
    return Buffer.concat([field(1, 17), field(4, 3), field(24, error)]);
}
export function writeFixture(directory, {
    id = ID, owner = id, beforeStopReason = 11, stopReason = 2, status = 3,
    text = LAST_TEXT, errorText = SAFETY_ERROR, laterError = false, laterPending = false,
    tools = false, badPayload = false, format = 0, multipleRetries = false,
    firstType = 14, intermediateType = 17,
} = {}) {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, id + '.db');
    rmSync(path, { force: true }); // caller-owned temporary fixture only
    const db = new DatabaseSync(path);
    try {
        db.exec(`
            CREATE TABLE trajectory_meta (
                trajectory_id TEXT,
                cascade_id TEXT
            );
            CREATE TABLE steps (
                idx INTEGER PRIMARY KEY,
                step_type INTEGER,
                status INTEGER,
                step_format INTEGER,
                error_details BLOB,
                step_payload BLOB
            );
        `);
        db.prepare('INSERT INTO trajectory_meta VALUES (?,?)').run('synthetic-trajectory', owner);
        const insert = db.prepare('INSERT INTO steps VALUES (?,?,?,?,NULL,?)');
        insert.run(0, firstType, 3, 0, Buffer.concat([field(1, firstType), field(4, 3)]));
        insert.run(1, 15, 3, 0, replyPayload({ text: FIRST_TEXT, stopReason: beforeStopReason }));
        insert.run(2, 17, 3, 0, errorPayload(errorText));
        insert.run(3, 15, status, format, badPayload ? Buffer.from([0xff]) : replyPayload({ text, stopReason, status, tools }));
        if (multipleRetries) {
            db.prepare('UPDATE steps SET step_payload=? WHERE idx=3').run(replyPayload({ text: 'another rejected draft', stopReason: 11 }));
            insert.run(4, intermediateType, 3, 0, errorPayload(SAFETY_ERROR + ' (later attempt)'));
            insert.run(5, 15, 3, 0, replyPayload({ text, stopReason }));
        }
        if (laterError) insert.run(4, 17, 3, 0, errorPayload('new terminal failure'));
        if (laterPending) insert.run(4, 15, 2, 0, replyPayload({ status: 2, text: 'unfinished' }));
    } finally { db.close(); }
    return path;
}
