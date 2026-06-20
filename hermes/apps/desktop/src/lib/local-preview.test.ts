import { describe, expect, it } from 'vitest'

import { localPreviewTarget } from './local-preview'

describe('localPreviewTarget', () => {
  it('accepts localhost http preview URLs', () => {
    const target = localPreviewTarget('http://127.0.0.1:5174/index.html')

    expect(target?.kind).toBe('url')
    expect(target?.url).toBe('http://127.0.0.1:5174/index.html')
  })

  it('rejects external or malformed http preview URLs', () => {
    expect(localPreviewTarget('https://emia/')).toBeNull()
    expect(localPreviewTarget('https://example.com/demo.html')).toBeNull()
  })
})
