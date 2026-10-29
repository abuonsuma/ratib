import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absoluteUrl, buildEmail, escapeHtml, singleLine } from '../lib/email.ts';

const SITE = 'https://orders.example.com';

test('job_status email has the reference, stage, note and a link to the job', () => {
  const m = buildEmail('job_status', { org_name: 'Asempa Fie Graphics', job_ref: 'JOB-2026-0007', title: 'Church banner', status_label: 'Ready for Collection', note: 'Please bring your job number.', link: '/portal/jobs/abc' }, SITE);
  assert.equal(m.subject, 'JOB-2026-0007: Ready for Collection');
  assert.match(m.text, /Church banner/);
  assert.match(m.text, /Please bring your job number\./);
  assert.match(m.text, /https:\/\/orders\.example\.com\/portal\/jobs\/abc/);
  assert.match(m.html, /View my job/);
});

test('job_submitted email', () => {
  const m = buildEmail('job_submitted', { org_name: 'Demo', job_ref: 'JOB-2026-0001', title: 'Cards', link: '/portal/jobs/x' }, SITE);
  assert.equal(m.subject, 'JOB-2026-0001 received');
  assert.doesNotMatch(m.text, /Message from/);
});

test('everything user-supplied is escaped in the HTML', () => {
  const m = buildEmail('job_status', { org_name: '<b>Evil</b>', job_ref: 'J', title: '<script>alert(1)</script>', status_label: 'A&B', note: '<img src=x onerror=alert(1)>\nline two' }, SITE);
  assert.ok(!m.html.includes('<script>'));
  assert.ok(!m.html.includes('<img'));
  assert.ok(!m.html.includes('<b>Evil'));
  assert.match(m.html, /&lt;script&gt;/);
  assert.match(m.html, /line two/);
});

test('subjects cannot carry new header lines', () => {
  const m = buildEmail('job_status', { job_ref: 'J-1\r\nBcc: attacker@evil.test', status_label: 'Done\nX: y', title: 't' }, SITE);
  assert.ok(!/[\r\n]/.test(m.subject));
  assert.equal(singleLine('a\r\nb\tc'), 'a b c');
});

test('links to other sites are replaced with our own dashboard', () => {
  assert.equal(absoluteUrl('https://evil.test/phish', SITE), 'https://orders.example.com/portal/dashboard');
  assert.equal(absoluteUrl('//evil.test/x', SITE), 'https://orders.example.com/portal/dashboard');
  assert.equal(absoluteUrl('javascript:alert(1)', SITE), 'https://orders.example.com/portal/dashboard');
  assert.equal(absoluteUrl(undefined, SITE), 'https://orders.example.com/portal/dashboard');
  assert.equal(absoluteUrl('/portal/jobs/1', SITE), 'https://orders.example.com/portal/jobs/1');
  assert.throws(() => absoluteUrl('/x', 'ftp://site.test'), /invalid_site_url/);
});

test('unknown templates fail instead of sending something wrong', () => {
  assert.throws(() => buildEmail('mystery', {}, SITE), /unknown_template/);
});

test('escapeHtml', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});
