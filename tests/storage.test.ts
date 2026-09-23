/**
 * Path handling. These are the functions that decide where bytes land, so
 * they are the ones a traversal or header-injection attempt would target.
 */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

process.env.STORAGE_ROOT ??= '/var/lib/aktivacity/storage';

type Storage = typeof import('../src/lib/files/storage');
let storage: Storage;

before(async () => {
  storage = await import('../src/lib/files/storage');
});

describe('absolutePath refuses to escape STORAGE_ROOT', () => {
  const escapes = [
    '../etc/passwd',
    'files/../../etc/passwd',
    '/etc/passwd',
    'files/../../../',
  ];

  test('every traversal attempt throws', () => {
    for (const attempt of escapes) {
      assert.throws(
        () => storage.absolutePath(attempt),
        /outside STORAGE_ROOT/,
        `expected ${attempt} to be refused`,
      );
    }
  });

  test('a legitimate relative path resolves inside the root', () => {
    const resolved = storage.absolutePath('files/clients/1/2026-09/x.mp4');
    assert.ok(resolved.startsWith(storage.storageRoot()));
  });
});

describe('safeExtension', () => {
  test('keeps plain extensions', () => {
    assert.equal(storage.safeExtension('Video_Final_v2.mp4'), '.mp4');
    assert.equal(storage.safeExtension('brief.PDF'), '.pdf');
  });

  test('drops anything that is not a short alphanumeric extension', () => {
    assert.equal(storage.safeExtension('payload.php%00'), '');
    assert.equal(storage.safeExtension('archive.tar.gz-with-junk'), '');
    assert.equal(storage.safeExtension('no-extension'), '');
    assert.equal(storage.safeExtension('..'), '');
    assert.equal(storage.safeExtension('trailing.'), '');
  });
});

describe('storage paths are built from identifiers, not user input', () => {
  test('a hostile filename cannot influence the directory', () => {
    const relative = storage.deliverableRelativePath({
      clientId: 7,
      periodYear: 2026,
      periodMonth: 9,
      projectId: 12,
      deliverableId: 34,
      versionNo: 2,
      storageKey: '0f5e5f7a-1111-4222-8333-444455556666',
      originalFilename: '../../../../etc/passwd',
    });
    assert.equal(
      relative,
      'files/clients/7/2026-09/projects/12/deliverables/34/v2/0f5e5f7a-1111-4222-8333-444455556666',
    );
    assert.doesNotThrow(() => storage.absolutePath(relative));
  });

  test('the month is zero-padded so directories sort correctly', () => {
    const relative = storage.deliverableRelativePath({
      clientId: 1, periodYear: 2026, periodMonth: 3, projectId: 1,
      deliverableId: 1, versionNo: 1,
      storageKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      originalFilename: 'a.mov',
    });
    assert.ok(relative.includes('/2026-03/'));
  });
});

describe('contentDisposition cannot inject headers', () => {
  test('control characters are stripped', () => {
    const header = storage.contentDisposition('evil\r\nX-Injected: yes.mp4');
    assert.ok(!header.includes('\r'));
    assert.ok(!header.includes('\n'));
  });

  test('quotes and backslashes cannot break out of the quoted form', () => {
    const header = storage.contentDisposition('a"; download="b.exe');
    const ascii = /filename="([^"]*)"/.exec(header);
    assert.ok(ascii, 'expected a quoted filename');
    assert.ok(!ascii[1].includes('"'));
  });

  test('non-ASCII names survive in the RFC 5987 form', () => {
    const header = storage.contentDisposition('تقرير.pdf');
    assert.ok(header.includes("filename*=UTF-8''"));
    assert.ok(header.includes(encodeURIComponent('تقرير.pdf')));
  });
});
