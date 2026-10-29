import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrgSlug, safeNextPath, safeNextPathOrNull } from '../lib/tenant.ts';
import { hexToRgbTriplet, ownerFirstName } from '../lib/format.ts';

test('single-tenant and development use the default slug', () => {
  assert.equal(resolveOrgSlug('localhost:3000', { defaultSlug: 'demo-print' }), 'demo-print');
  assert.equal(resolveOrgSlug('anything.example.com', { defaultSlug: 'demo-print' }), 'demo-print');
  assert.equal(resolveOrgSlug('localhost:3000', {}), null);
  assert.equal(resolveOrgSlug('localhost', { defaultSlug: 'Bad Slug!' }), null);
});

test('multi-tenant resolves the subdomain', () => {
  const env = { rootDomain: 'ratib.app', defaultSlug: 'demo-print' };
  assert.equal(resolveOrgSlug('acme.ratib.app', env), 'acme');
  assert.equal(resolveOrgSlug('ACME.ratib.app:443', env), 'acme');
  assert.equal(resolveOrgSlug('www.ratib.app', env), null);
  assert.equal(resolveOrgSlug('a.b.ratib.app', env), null);
  assert.equal(resolveOrgSlug('evil.com', env), 'demo-print'); // falls back only if a default is configured
  assert.equal(resolveOrgSlug('evil.com', { rootDomain: 'ratib.app' }), null);
});

test('redirects stay inside the site', () => {
  assert.equal(safeNextPath('/portal/jobs/1'), '/portal/jobs/1');
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', '', null, undefined]) {
    assert.equal(safeNextPath(bad as string), '/portal/dashboard', String(bad));
  }
});

test('brand colour and names', () => {
  assert.equal(hexToRgbTriplet('#1d4ed8'), '29 78 216');
  assert.equal(hexToRgbTriplet('not a colour'), '29 78 216');
  assert.equal(ownerFirstName('Ama Mensah'), 'Ama');
  assert.equal(ownerFirstName(''), 'there');
});

test('safeNextPathOrNull returns null instead of a default', () => {
  assert.equal(safeNextPathOrNull('/admin/jobs/1'), '/admin/jobs/1');
  for (const bad of ['', null, undefined, '//evil.com', 'https://evil.com', '/\\evil.com']) assert.equal(safeNextPathOrNull(bad as string), null, String(bad));
});
