import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { verifyAgyRetry, decodeTrajectoryStep } from '../lib/gemini/trajectory.js';
import { hasSqlite, ID, SAFETY_ERROR, LAST_TEXT, writeFixture, replyPayload } from './fixtures/agy-trajectory.mjs';

const directory = mkdtempSync(join(tmpdir(), 'agy-trajectory-'));
test.after(() => rmSync(directory, { recursive: true, force: true }));
const request = (extra = {}) => ({
    directory, version: '1.4.1', conversationId: ID, lastTextStep: 3, lastErrorStep: 2,
    errorText: SAFETY_ERROR, expectedText: LAST_TEXT, waitMs: 0, ...extra,
});

test('retry verification returns only the later normal response without changing the database', { skip: !hasSqlite }, async () => {
    const path = writeFixture(directory);
    const before = readFileSync(path);
    const outcome = await verifyAgyRetry(request());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.response, LAST_TEXT);
    assert.equal(outcome.stopReason, 2);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(path + '-journal'), false);
});

test('filtering, incomplete results, new errors, unknown schemas and other conversations cannot recover', { skip: !hasSqlite }, async () => {
    for (const variant of [
        { stopReason: 11 }, { stopReason: 1 }, { stopReason: 3 }, { stopReason: 13 }, { stopReason: 999 },
        { status: 2 }, { beforeStopReason: 2 }, { owner: '22222222-2222-4222-8222-222222222222' },
        { text: 'different reply' }, { errorText: 'different error' }, { laterError: true }, { laterPending: true },
        { tools: true }, { badPayload: true }, { format: 1 },
    ]) {
        writeFixture(directory, variant);
        const outcome = await verifyAgyRetry(request());
        assert.equal(outcome.ok, false, JSON.stringify(variant));
        assert.ok(outcome.reason);
    }
});

test('tested CLI versions accept the exact reply or one framing LF, without trimming mismatches', { skip: !hasSqlite }, async () => {
    writeFixture(directory);
    for (const version of ['1.4.1', '1.4.2', '1.4.10']) {
        for (const suffix of ['', '\n']) {
            const result = await verifyAgyRetry(request({ version, expectedText: LAST_TEXT + suffix }));
            assert.equal(result.ok, true);
            assert.equal(result.response, LAST_TEXT);
        }
        for (const expectedText of [LAST_TEXT + '\n\n', LAST_TEXT + ' ', ' ' + LAST_TEXT, LAST_TEXT + '\r\n']) {
            assert.equal((await verifyAgyRetry(request({ version, expectedText }))).reason, 'reply-differs-from-events');
        }
    }
});

test('missing identity, unsupported versions and unavailable databases preserve failure', async () => {
    for (const extra of [
        { conversationId: '../escape' }, { conversationId: null }, { lastErrorStep: 3 },
        { version: '1.4.0' }, { version: '1.4.3' }, { version: '1.4.11' }, { version: null }, { expectedText: '' }, { errorText: undefined },
        { directory: join(directory, 'does-not-exist') },
    ]) {
        assert.equal((await verifyAgyRetry(request(extra))).ok, false);
    }
});

test('bounded wait can observe a just-persisted retry without crossing request IDs', { skip: !hasSqlite }, async () => {
    const first = '33333333-3333-4333-8333-333333333333';
    const second = '44444444-4444-4444-8444-444444444444';
    const pending = verifyAgyRetry(request({ conversationId: first, waitMs: 800 }));
    writeFixture(directory, { id: second, text: 'other request' });
    const timer = setTimeout(() => writeFixture(directory, { id: first }), 60);
    try {
        const [a, b] = await Promise.all([
            pending,
            verifyAgyRetry(request({ conversationId: second, expectedText: 'other request' })),
        ]);
        assert.equal(a.response, LAST_TEXT);
        assert.equal(b.response, 'other request');
    } finally { clearTimeout(timer); }
});

test('cancelled recovery does not deliver a persisted response', { skip: !hasSqlite }, async () => {
    writeFixture(directory);
    const controller = new AbortController();
    controller.abort();
    assert.equal((await verifyAgyRetry(request({ signal: controller.signal }))).ok, false);
});

test('several filtered attempts can recover when the final error refers to the first one', { skip: !hasSqlite }, async () => {
    writeFixture(directory, { multipleRetries: true });
    const result = await verifyAgyRetry(request({ version: '1.4.10', lastTextStep: 5, lastErrorStep: 4 }));
    assert.equal(result.ok, true);
    assert.equal(result.errorStep, 2);
    assert.equal(result.response, LAST_TEXT);
});

test('1.4.10 rejects a filtered final retry and completed tool or unknown steps', { skip: !hasSqlite }, async () => {
    writeFixture(directory, { multipleRetries: true, stopReason: 11 });
    assert.equal((await verifyAgyRetry(request({ version: '1.4.10', lastTextStep: 5, lastErrorStep: 4 }))).reason, 'retry-not-normal');
    for (const variant of [{ firstType: 15 }, { multipleRetries: true, intermediateType: 132 }, { multipleRetries: true, intermediateType: 999 }]) {
        writeFixture(directory, variant);
        const extra = variant.multipleRetries ? { lastTextStep: 5, lastErrorStep: 2 } : {};
        assert.equal((await verifyAgyRetry(request({ version: '1.4.10', ...extra }))).reason, 'unexpected-trajectory-step');
    }
});

test('missing optional SQLite support preserves the failure without installing a fallback', () => {
    const script = `import {verifyAgyRetry} from ${JSON.stringify(new URL('../lib/gemini/trajectory.js', import.meta.url).href)}; console.log(JSON.stringify(await verifyAgyRetry(${JSON.stringify(request())})))`;
    const child = spawnSync(process.execPath, ['--no-experimental-sqlite', '--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).reason, 'sqlite-unavailable');
});

test('protobuf boundary rejects truncation, invalid varints, mismatched identities and tool calls', () => {
    const row = { idx: 3, step_type: 15, status: 3, step_format: 0, error_details: null };
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0x00]), Buffer.from([0x0a, 0x7f]), replyPayload({ tools: true }), replyPayload({ type: 14 })]) {
        assert.throws(() => decodeTrajectoryStep({ ...row, step_payload: bytes }));
    }
    assert.equal(decodeTrajectoryStep({ ...row, step_payload: replyPayload() }).stopReason, 2);
});
