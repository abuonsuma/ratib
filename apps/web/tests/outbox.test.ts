import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processOutbox, type OutboxDeps, type OutboxRow } from '../lib/outbox.ts';
import { createResendSender, type FetchLike } from '../lib/resend.ts';

const row = (n: number): OutboxRow => ({ id: `id-${n}`, to_email: `u${n}@test.dev`, template: 'job_status', payload: {}, dedupe_key: `key-${n}`, attempts: 1 });

function fakes(overrides: Partial<OutboxDeps> = {}) {
  const log = { sent: [] as string[], marked: [] as string[], failed: [] as [string, string][], keys: [] as string[] };
  const deps: OutboxDeps = {
    render: (r) => ({ subject: `s-${r.id}`, html: '<p>h</p>', text: 't' }),
    send: async (e) => { log.sent.push(e.to); log.keys.push(e.idempotencyKey); },
    markSent: async (id) => { log.marked.push(id); },
    markFailed: async (id, err) => { log.failed.push([id, err]); },
    ...overrides,
  };
  return { deps, log };
}

test('sends each row once and records it', async () => {
  const { deps, log } = fakes();
  const r = await processOutbox([row(1), row(2)], deps);
  assert.deepEqual(r, { sent: 2, failed: 0, warnings: [] });
  assert.deepEqual(log.sent, ['u1@test.dev', 'u2@test.dev']);
  assert.deepEqual(log.marked, ['id-1', 'id-2']);
  assert.deepEqual(log.keys, ['key-1', 'key-2']);
});

test('one failure does not stop the rest, and the reason is recorded', async () => {
  const { deps, log } = fakes({
    send: async (e) => { if (e.to === 'u2@test.dev') throw new Error('Resend 422: invalid address'); },
  });
  const r = await processOutbox([row(1), row(2), row(3)], deps);
  assert.equal(r.sent, 2);
  assert.equal(r.failed, 1);
  assert.deepEqual(log.failed, [['id-2', 'Resend 422: invalid address']]);
  assert.deepEqual(log.marked, ['id-1', 'id-3']);
});

test('a template that cannot be rendered is a failure, not a crash', async () => {
  const { deps, log } = fakes({ render: () => { throw new Error('unknown_template:x'); } });
  const r = await processOutbox([row(1)], deps);
  assert.equal(r.failed, 1);
  assert.equal(log.failed[0][1], 'unknown_template:x');
});

test('if recording success fails, the email still counts as sent and a warning is raised', async () => {
  const { deps } = fakes({ markSent: async () => { throw new Error('db down'); } });
  const r = await processOutbox([row(1)], deps);
  assert.equal(r.sent, 1);
  assert.equal(r.failed, 0);
  assert.match(r.warnings[0], /sent but could not record id-1/);
});

test('if recording failure fails too, we still carry on', async () => {
  const { deps } = fakes({
    send: async () => { throw new Error('boom'); },
    markFailed: async () => { throw new Error('db down'); },
  });
  const r = await processOutbox([row(1), row(2)], deps);
  assert.equal(r.failed, 2);
  assert.equal(r.warnings.length, 2);
});

test('an empty batch is fine', async () => {
  const { deps } = fakes();
  assert.deepEqual(await processOutbox([], deps), { sent: 0, failed: 0, warnings: [] });
});

test('Resend sender: request shape', async () => {
  let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
  const fetchImpl: FetchLike = async (url, init) => { seen = { url, headers: init.headers, body: init.body }; return { ok: true, status: 200, text: async () => '{}' }; };
  const send = createResendSender({ apiKey: 're_test_123', from: 'Asempa <orders@example.com>', fetchImpl });
  await send({ to: 'a@b.co', subject: 'Hi', html: '<p>x</p>', text: 'x', idempotencyKey: 'job:1:hist:2' });
  assert.ok(seen);
  const s = seen as unknown as { url: string; headers: Record<string, string>; body: string };
  assert.equal(s.url, 'https://api.resend.com/emails');
  assert.equal(s.headers.Authorization, 'Bearer re_test_123');
  assert.equal(s.headers['Idempotency-Key'], 'job:1:hist:2');
  assert.deepEqual(JSON.parse(s.body), { from: 'Asempa <orders@example.com>', to: ['a@b.co'], subject: 'Hi', html: '<p>x</p>', text: 'x' });
});

test('Resend sender: provider errors become failures with the status', async () => {
  const fetchImpl: FetchLike = async () => ({ ok: false, status: 422, text: async () => 'x'.repeat(500) });
  const send = createResendSender({ apiKey: 'k', from: 'f@x.co', fetchImpl });
  await assert.rejects(send({ to: 'a@b.co', subject: 's', html: 'h', text: 't' }), (e: Error) => /^Resend 422: x{200}$/.test(e.message));
});
