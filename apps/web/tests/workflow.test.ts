import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, countByGroup, statusTone, clientAction, type Stage, type HistoryEntry } from '../lib/workflow.ts';

const keys: [string, string, boolean, boolean][] = [
  ['draft', 'Draft', false, false], ['submitted', 'Submitted', false, false], ['under_review', 'Under Review', false, false],
  ['awaiting_quotation', 'Awaiting Quotation', false, false], ['awaiting_client_approval', 'Awaiting Your Approval', false, false],
  ['awaiting_payment', 'Awaiting Payment', false, false], ['payment_confirmed', 'Payment Confirmed', false, false],
  ['queued_for_production', 'Queued', false, false], ['in_production', 'In Production', false, false],
  ['quality_check', 'Quality Check', false, false], ['ready_for_collection', 'Ready for Collection', false, false],
  ['out_for_delivery', 'Out for Delivery', false, false], ['completed', 'Completed', false, true],
  ['on_hold', 'On Hold', true, false], ['cancelled', 'Cancelled', true, true],
];
const stages: Stage[] = keys.map(([status_key, label, off_track, is_terminal], i) => ({
  status_key, label, position: off_track ? 90 + i : i + 1, off_track, is_terminal, client_visible: true,
}));
const h = (to: string, day: number, note: string | null = null): HistoryEntry => ({
  to_status: to, label: to, client_note: note, created_at: `2026-10-${String(day).padStart(2, '0')}T09:00:00Z`,
});

test('draft is hidden and off-track stages are not in the main line', () => {
  const t = buildTimeline(stages, [h('submitted', 1)], 'submitted');
  assert.equal(t.steps.length, 12);
  assert.equal(t.steps[0].key, 'submitted');
  assert.ok(!t.steps.some((s) => s.key === 'on_hold' || s.key === 'cancelled' || s.key === 'draft'));
});

test('steps before the current one are done, after are upcoming', () => {
  const t = buildTimeline(stages, [h('submitted', 1), h('under_review', 2, 'Checking artwork'), h('in_production', 4, 'Printing today')], 'in_production');
  const byKey = Object.fromEntries(t.steps.map((s) => [s.key, s.state]));
  assert.equal(byKey.submitted, 'done');
  assert.equal(byKey.under_review, 'done');
  assert.equal(byKey.in_production, 'current');
  assert.equal(byKey.quality_check, 'upcoming');
  assert.equal(t.steps.find((s) => s.key === 'in_production')?.note, 'Printing today');
  assert.equal(t.steps.find((s) => s.key === 'under_review')?.at, '2026-10-02T09:00:00Z');
  assert.equal(t.offTrack, null);
  assert.ok(t.percent > 40 && t.percent < 100);
});

test('completed jobs show everything done at 100%', () => {
  const t = buildTimeline(stages, [h('submitted', 1), h('completed', 9)], 'completed');
  assert.ok(t.steps.every((s) => s.state === 'done'));
  assert.equal(t.percent, 100);
});

test('on hold keeps the paused stage as current and reports the hold', () => {
  const t = buildTimeline(stages, [h('submitted', 1), h('in_production', 3), h('on_hold', 4, 'Waiting for new artwork')], 'on_hold');
  assert.equal(t.steps.find((s) => s.key === 'in_production')?.state, 'current');
  assert.equal(t.offTrack?.label, 'On Hold');
  assert.equal(t.offTrack?.note, 'Waiting for new artwork');
});

test('skipped stages (workflow without them) still render without crashing', () => {
  const small = stages.filter((s) => ['draft', 'submitted', 'in_production', 'completed'].includes(s.status_key));
  const t = buildTimeline(small, [h('submitted', 1), h('in_production', 2)], 'in_production');
  assert.deepEqual(t.steps.map((s) => s.state), ['done', 'current', 'upcoming']);
});

test('dashboard counts exclude drafts from the submitted total', () => {
  const c = countByGroup(['draft', 'draft', 'submitted', 'under_review', 'awaiting_client_approval', 'awaiting_payment', 'in_production', 'quality_check', 'ready_for_collection', 'completed', 'cancelled']);
  assert.equal(c.drafts, 2);
  assert.equal(c.total, 9);
  assert.equal(c.in_review, 2);
  assert.equal(c.awaiting_approval, 1);
  assert.equal(c.awaiting_payment, 1);
  assert.equal(c.in_production, 2);
  assert.equal(c.ready, 1);
  assert.equal(c.completed, 1);
});

test('status tones and client actions', () => {
  assert.equal(statusTone('in_production'), 'violet');
  assert.equal(statusTone('cancelled'), 'red');
  assert.equal(statusTone('something_new'), 'slate');
  assert.ok(clientAction('awaiting_payment'));
  assert.equal(clientAction('in_production'), null);
});
