import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJobDraft, friendlyDbError, emptyItem } from '../lib/job.ts';

const cat = '11111111-2222-4333-8444-555555555555';
const today = new Date('2026-10-27T10:00:00Z');
const good = () => ({
  category_id: cat, title: 'Wedding programmes', due_date: '2026-11-05', delivery_method: 'collection',
  items: [{ ...emptyItem(), description: 'Programme booklet', quantity: 150, size: 'A5', orientation: 'portrait' }],
});

test('accepts a valid job and trims text', () => {
  const r = parseJobDraft({ ...good(), title: '  Wedding programmes  ' }, today);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.title, 'Wedding programmes');
    assert.equal(r.value.items[0].quantity, 150);
    assert.equal(r.value.delivery_address, '');
  }
});

test('collects field errors', () => {
  const r = parseJobDraft({ category_id: 'nope', title: 'ab', items: [{ description: 'x', quantity: 0 }] }, today);
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.ok(r.errors.category_id && r.errors.title);
    assert.ok(r.errors['items.0.description'] && r.errors['items.0.quantity']);
  }
});

test('delivery needs an address; collection ignores one', () => {
  const bad = parseJobDraft({ ...good(), delivery_method: 'delivery' }, today);
  assert.ok(!bad.ok && bad.errors.delivery_address);
  const ok = parseJobDraft({ ...good(), delivery_method: 'delivery', delivery_address: 'East Legon, Accra' }, today);
  assert.ok(ok.ok);
  const col = parseJobDraft({ ...good(), delivery_address: 'ignored' }, today);
  assert.ok(col.ok && col.value.delivery_address === '');
});

test('dates', () => {
  assert.ok(!parseJobDraft({ ...good(), due_date: '2026-10-26' }, today).ok);
  assert.ok(parseJobDraft({ ...good(), due_date: '2026-10-27' }, today).ok);
  assert.ok(parseJobDraft({ ...good(), due_date: '' }, today).ok);
  assert.ok(!parseJobDraft({ ...good(), due_date: 'tomorrow' }, today).ok);
});

test('quantity and item limits', () => {
  for (const q of [0, -1, 1.5, 10_000_001, 'abc', null]) {
    assert.ok(!parseJobDraft({ ...good(), items: [{ ...emptyItem(), description: 'Flyers', quantity: q }] }, today).ok, String(q));
  }
  assert.ok(parseJobDraft({ ...good(), items: [{ ...emptyItem(), description: 'Flyers', quantity: '250' }] }, today).ok);
  assert.ok(!parseJobDraft({ ...good(), items: [] }, today).ok);
  assert.ok(!parseJobDraft({ ...good(), items: Array(21).fill({ ...emptyItem(), description: 'Flyers' }) }, today).ok);
});

test('unknown enum values fall back safely; prices and status are never read', () => {
  const r = parseJobDraft({ ...good(), status: 'completed', total: 1, price: 0, items: [{ ...emptyItem(), description: 'Flyers', orientation: 'sideways', colour_mode: 'neon', price: 0 }] }, today);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.items[0].orientation, 'not_applicable');
    assert.equal(r.value.items[0].colour_mode, 'full_colour');
    assert.ok(!('status' in r.value) && !('total' in r.value) && !('price' in r.value.items[0]));
  }
});

test('database error codes become friendly messages', () => {
  assert.match(friendlyDbError('ERROR: due_date_in_past'), /already passed/);
  assert.match(friendlyDbError('weird'), /Something went wrong/);
});
