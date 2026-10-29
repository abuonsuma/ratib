import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFile, safeFilename, storagePath, pathBelongsToJob, formatBytes, MAX_FILE_BYTES, extensionOf } from '../lib/files.ts';

test('accepts normal print files', () => {
  for (const name of ['logo.pdf', 'Poster.PNG', 'brand.AI', 'layout.indd', 'photos.zip', 'scan.tiff']) {
    assert.equal(validateFile({ name, size: 5000 }), null, name);
  }
});

test('rejects dangerous or unknown types', () => {
  for (const name of ['virus.exe', 'run.bat', 'page.html', 'script.js', 'noextension', '.hidden', 'trailingdot.', 'archive.pdf.exe']) {
    assert.ok(validateFile({ name, size: 5000 }), name);
  }
});

test('enforces size limits', () => {
  assert.ok(validateFile({ name: 'a.pdf', size: 0 }));
  assert.equal(validateFile({ name: 'a.pdf', size: MAX_FILE_BYTES }), null);
  assert.match(validateFile({ name: 'a.pdf', size: MAX_FILE_BYTES + 1 }) ?? '', /limit/);
});

test('safe filenames cannot escape the folder', () => {
  assert.equal(safeFilename('../../etc/passwd.pdf'), 'etc-passwd.pdf');
  assert.equal(safeFilename('My Logo (final).PNG'), 'My-Logo-final.png');
  assert.equal(safeFilename('名前.pdf'), 'file.pdf');
  assert.ok(!safeFilename('a/b\\c.pdf').includes('/'));
  assert.ok(safeFilename('x'.repeat(300) + '.pdf').length <= 84);
});

test('storage paths stay inside the job folder', () => {
  const p = storagePath('org1', 'job1', 'u1', 'Brief v2.pdf');
  assert.equal(p, 'org1/job1/u1-Brief-v2.pdf');
  assert.ok(pathBelongsToJob(p, 'org1', 'job1'));
  assert.ok(!pathBelongsToJob(p, 'org1', 'job2'));
  assert.ok(!pathBelongsToJob('org1/job1/../job2/x.pdf', 'org1', 'job1'));
  assert.ok(!pathBelongsToJob('org1/job1/sub/x.pdf', 'org1', 'job1'));
});

test('helpers', () => {
  assert.equal(extensionOf('a.b.C'), 'c');
  assert.equal(formatBytes(1536), '2 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});
