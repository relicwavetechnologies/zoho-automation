import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayOpPhrase, toolLabel } from '../../src/domain/tools/tool-labels.ts';

// A status card read `Divo — omsSiteData · tools.invoke`: a camelCase
// identifier and an internal namespace, neither written for the person waiting.
describe('naming a governed call', () => {
  it('spells a tool the way the product does, acronyms included', () => {
    assert.equal(toolLabel('omsSiteData').name, 'OMS Site Data');
    assert.equal(toolLabel('googleDrive').name, 'Google Drive');
    assert.equal(toolLabel('airtableRecords').name, 'Airtable Records');
  });

  // Unknown ids still have to read as words — a new tool must not print raw.
  it('title-cases an id the table has never heard of', () => {
    assert.equal(toolLabel('acmeWidgetSync').name, 'Acme Widget Sync');
  });

  // It is the operation that simply runs the tool, so it is true of nearly
  // every row and says nothing the tool's own name has not already said.
  it('says nothing for the operation that just runs the tool', () => {
    assert.equal(gatewayOpPhrase('tools.invoke'), undefined);
    assert.equal(gatewayOpPhrase(undefined), undefined);
  });

  // The MCP-backed families take `{ op: 'call', nativeTool, input }`, so `call`
  // is the same "it ran the tool" statement in different clothing. Every Gmail
  // step in a real run was captioned "call" beside a row already saying Gmail.
  it('says nothing for the MCP families\' version of the same operation', () => {
    assert.equal(gatewayOpPhrase('call'), undefined);
    assert.equal(gatewayOpPhrase('call_resolved_sheet'), undefined);
  });

  // Introspection is not the operation it introspects. A row that dropped this
  // would show the product alone and read as though the work had happened.
  it('keeps a schema lookup distinguishable from doing the thing', () => {
    assert.equal(gatewayOpPhrase('describe'), 'Checking how it works');
    assert.equal(gatewayOpPhrase('search_gmail_messages'), 'Search gmail messages');
  });

  it('gives the operations worth naming real words', () => {
    assert.equal(gatewayOpPhrase('tools.preflight'), 'Checking access');
    assert.equal(gatewayOpPhrase('media.image_ocr'), 'Reading a picture');
    // Unmapped, but still not an identifier: the namespace goes, the rest reads.
    assert.equal(gatewayOpPhrase('tools.rehydrate'), 'Rehydrate');
  });

  // The container ships separately, so a card can be served by a backend newer
  // than the container feeding it. That skew printed "Semrush · Semrush · tools
  // invoke" — the joined form translated as though it were all one operation.
  it('reads the older joined form without repeating the tool name', () => {
    assert.equal(gatewayOpPhrase('semrush · tools.invoke'), undefined);
    // Including the spelling an older backend had already made of it.
    assert.equal(gatewayOpPhrase('Web Search · tools invoke'), undefined);
    assert.equal(gatewayOpPhrase('googleDrive · tools.preflight'), 'Checking access');
  });
});
