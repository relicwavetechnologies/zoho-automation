import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_PREVIEW_CHARS,
  ARTIFACT_PREVIEW_SOURCE_CHARS,
  previewOf,
} from '../../src/domain/artifact/preview.ts';

/**
 * What a list says a document is.
 *
 * The case that made this a domain function rather than a `slice(0, 400)` is
 * the last one here: every HTML artifact this runtime writes opens with a
 * stylesheet thousands of characters long, so a preview cut from the front of
 * the file is a preview of CSS. Nothing about that is visible in a screenshot
 * of a card — it just looks like the feature does not work.
 */
describe('artifact preview', () => {
  it('keeps a markdown document readable and drops its syntax', () => {
    const preview = previewOf(
      '# Q3 review\n\n- **Sharma** overspent\n> see [the ledger](https://x.test)\n---\n',
      'text/markdown',
    );
    assert.deepEqual(preview.split('\n'), ['Q3 review', 'Sharma overspent', 'see the ledger']);
  });

  it('leaves nothing behind from an image', () => {
    assert.equal(previewOf('![a chart of spend](chart.png)\nText.', 'text/markdown'), 'Text.');
  });

  it('reaches the text of an HTML document past its stylesheet', () => {
    const body = `<style>\n${'.a { color: red; }\n'.repeat(200)}</style>`
      + '<h1>Q4 Flavour Performance</h1><p>Mango led the quarter.</p>';
    assert.ok(body.indexOf('Q4') > 3_000, 'the fixture has to be a realistic document');
    assert.deepEqual(
      previewOf(body, 'text/html').split('\n'),
      ['Q4 Flavour Performance', 'Mango led the quarter.'],
    );
  });

  it('never lets a script body reach a reader as text', () => {
    const preview = previewOf(
      '<script>const secret = "token";</script><p>Hello &amp; welcome</p>',
      'text/html',
    );
    assert.equal(preview, 'Hello & welcome');
  });

  it('decodes the entities a figure caption is made of', () => {
    // Straight off a real card, which showed the source instead: a document
    // that reads "&#9660; &minus;9.1%" is worse than the markup we strip.
    assert.equal(
      previewOf('<p>&#9660; &minus;9.1% vs 2,559 &mdash; Q4 &amp; Q3</p>', 'text/html'),
      '▼ −9.1% vs 2,559 — Q4 & Q3',
    );
  });

  it('leaves an entity it does not know exactly as written', () => {
    assert.equal(previewOf('<p>&notareal; &#x1F600;</p>', 'text/html'), '&notareal; 😀');
  });

  it('drops an element the read was cut in the middle of', () => {
    // What a bounded read of a long stylesheet actually looks like: an opening
    // tag and no closing one. Keeping the fragment would print CSS on a card.
    assert.equal(previewOf('<style>.a { color: red;', 'text/html'), '');
  });

  it('stays inside the budget however long the lines are', () => {
    const preview = previewOf(`${'word '.repeat(400)}\n${'more '.repeat(400)}`, 'text/markdown');
    assert.ok(preview.length <= ARTIFACT_PREVIEW_CHARS, `got ${preview.length}`);
  });

  it('reads a bounded head of the body and no more', () => {
    const body = `${'\n'.repeat(ARTIFACT_PREVIEW_SOURCE_CHARS)}Buried.`;
    assert.equal(previewOf(body, 'text/markdown'), '');
  });
});
