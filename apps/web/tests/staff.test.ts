import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCode, isOverdue, okMessage, reasonText, splitOptions, staffErrorMessage } from '../lib/staff.ts';

test('database error text maps to a friendly message', () => {
  assert.equal(errorCode('payment_required'), 'payment_required');
  assert.equal(errorCode('ERROR:  restricted_stage'), 'restricted_stage');
  assert.equal(errorCode('something unexpected'), 'unknown');
  assert.match(staffErrorMessage('approval_required'), /approved/);
  assert.match(staffErrorMessage('unknown'), /Something went wrong/);
  assert.match(staffErrorMessage('<script>'), /Something went wrong/);
  assert.match(staffErrorMessage(undefined), /Something went wrong/);
});

test('success messages come only from a fixed list', () => {
  assert.ok(okMessage('status'));
  assert.equal(okMessage('<b>hi</b>'), null);
  assert.equal(okMessage(undefined), null);
});

test('options are split into available and blocked, and reasons are readable', () => {
  const s = splitOptions([
    { status_key: 'a', label: 'A', allowed: true, reason: null },
    { status_key: 'b', label: 'B', allowed: false, reason: 'payment_required' },
  ]);
  assert.equal(s.allowed.length, 1);
  assert.equal(s.blocked.length, 1);
  assert.equal(reasonText('payment_required'), 'payment not confirmed yet');
  assert.equal(reasonText('weird_new_code'), 'not available right now');
  assert.equal(reasonText(null), '');
});

test('overdue rules', () => {
  assert.equal(isOverdue('2026-10-01', 'in_production', '2026-10-28'), true);
  assert.equal(isOverdue('2026-10-28', 'in_production', '2026-10-28'), false);
  assert.equal(isOverdue('2026-10-01', 'ready_for_collection', '2026-10-28'), false);
  assert.equal(isOverdue('2026-10-01', 'completed', '2026-10-28'), false);
  assert.equal(isOverdue(null, 'submitted', '2026-10-28'), false);
});
