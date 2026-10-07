/**
 * Which files may be viewed in place (brief §12). Pure: no database needed.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { previewContentType, previewKind } from '../src/lib/files/preview';

describe('previewing a file in place (brief §12)', () => {
  test('media and PDFs are previewable, by declared type or by extension', () => {
    assert.equal(previewKind('video/mp4', 'cut.bin'), 'video');
    assert.equal(previewKind(null, 'Master_v3.MOV'), 'video');
    assert.equal(previewKind('', 'thumb.jpeg'), 'image');
    assert.equal(previewKind('audio/mpeg; charset=binary', 'vo'), 'audio');
    assert.equal(previewKind(null, 'PO-2026.pdf'), 'pdf');
  });

  test('anything that could run script must be downloaded', () => {
    for (const [mime, name] of [
      ['text/html', 'page.html'], ['image/svg+xml', 'logo.svg'], [null, 'logo.svg'],
      ['application/javascript', 'x.js'], [null, 'design.psd'], [null, 'README'],
    ] as const) {
      assert.equal(previewContentType(mime, name), null, `${mime} ${name}`);
    }
  });

  test('a disguised file is served as what its name claims, never as HTML', () => {
    assert.equal(previewContentType('text/html', 'innocent.png'), 'image/png');
  });
});
