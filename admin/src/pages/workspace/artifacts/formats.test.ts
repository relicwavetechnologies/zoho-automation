import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { withDocumentTheme } from './data'

describe('artifact document transport', () => {
  it('switches the fetched wrapper theme without changing the document body', () => {
    const markup = '<html lang="en" data-theme="light"><body><h1>Report</h1></body></html>'
    assert.equal(
      withDocumentTheme(markup, 'dark'),
      '<html lang="en" data-theme="dark"><body><h1>Report</h1></body></html>',
    )
  })
})
