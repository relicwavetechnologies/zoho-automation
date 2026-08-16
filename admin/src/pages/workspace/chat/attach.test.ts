import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_FILES, MAX_FILE_BYTES, acceptFiles, formatBytes, isUnopenable, kindOf,
  kindOfSent, namedForClipboard, rejectionSentence, sentFrom,
} from './attach'

/** A file of a given size without allocating it — only `size` is ever read. */
function fake(name: string, type: string, size = 10): File {
  const file = new File([''], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('kindOf', () => {
  it('reads the type first', () => {
    assert.equal(kindOf(fake('a.png', 'image/png')), 'image')
    assert.equal(kindOf(fake('a.mp3', 'audio/mpeg')), 'audio')
    assert.equal(kindOf(fake('a.pdf', 'application/pdf')), 'doc')
  })

  it('falls back to the extension when the browser has no mapping', () => {
    // Browsers report application/octet-stream for extensions they do not
    // know, and .opus is one of them on several of them.
    assert.equal(kindOf(fake('call.opus', 'application/octet-stream')), 'audio')
  })
})

describe('isUnopenable', () => {
  it('turns away video and binaries', () => {
    // The short, stable half of the server's policy — the set the container has
    // no skill for and is not going to grow.
    assert.equal(isUnopenable(fake('clip.mp4', 'video/mp4')), true)
    assert.equal(isUnopenable(fake('setup.exe', 'application/octet-stream')), true)
    assert.equal(isUnopenable(fake('recording', 'video/quicktime')), true)
  })

  it('lets audio through, because the backend transcribes it', () => {
    // Refusing it here would be the browser out-guessing the server on the one
    // format where the server does the most useful thing with it.
    assert.equal(isUnopenable(fake('memo.m4a', 'audio/mp4')), false)
    assert.equal(isUnopenable(fake('call.opus', 'application/octet-stream')), false)
  })

  it('accepts anything it is unsure about', () => {
    // The classifier on the other side is the one that knows. A guess here
    // refuses files that work.
    assert.equal(isUnopenable(fake('export', 'application/octet-stream')), false)
    assert.equal(isUnopenable(fake('bundle.zip', 'application/zip')), false)
    assert.equal(isUnopenable(fake('q3.pdf', 'application/pdf')), false)
  })
})

describe('acceptFiles', () => {
  it('keeps what it is given', () => {
    const result = acceptFiles([], [fake('q3.pdf', 'application/pdf')])
    assert.equal(result.files.length, 1)
    assert.equal(result.rejected.length, 0)
  })

  it('adds to what is already held', () => {
    const held = [fake('a.pdf', 'application/pdf')]
    const result = acceptFiles(held, [fake('b.pdf', 'application/pdf')])
    assert.deepEqual(result.files.map((f) => f.name), ['a.pdf', 'b.pdf'])
  })

  it('drops a duplicate without saying anything', () => {
    // Dragging the same file twice is a slip, not a request.
    const held = [fake('a.pdf', 'application/pdf', 500)]
    const result = acceptFiles(held, [fake('a.pdf', 'application/pdf', 500)])
    assert.equal(result.files.length, 1)
    assert.equal(result.rejected.length, 0)
  })

  it('treats a same-named file of a different size as a different file', () => {
    const held = [fake('scan.pdf', 'application/pdf', 500)]
    const result = acceptFiles(held, [fake('scan.pdf', 'application/pdf', 900)])
    assert.equal(result.files.length, 2)
  })

  it('names a format it will not carry', () => {
    const result = acceptFiles([], [fake('clip.mp4', 'video/mp4')])
    assert.equal(result.files.length, 0)
    assert.match(result.rejected[0]!.reason, /no skill/i)
    assert.equal(result.rejected[0]!.name, 'clip.mp4')
  })

  it('names a file that is too large', () => {
    const result = acceptFiles([], [fake('huge.pdf', 'application/pdf', MAX_FILE_BYTES + 1)])
    assert.equal(result.files.length, 0)
    assert.match(result.rejected[0]!.reason, /larger than/)
  })

  it('keeps the ones that fit and names only the overflow', () => {
    // The failure this prevents: refusing the whole drop because it was one
    // file over, which makes the person work out which one to leave behind.
    const many = Array.from({ length: MAX_FILES + 2 }, (_, i) =>
      fake(`f${i}.pdf`, 'application/pdf'))
    const result = acceptFiles([], many)

    assert.equal(result.files.length, MAX_FILES)
    assert.equal(result.rejected.length, 2)
    assert.match(result.rejected[0]!.reason, new RegExp(`only ${MAX_FILES} files`))
  })

  it('counts what is already held against the cap', () => {
    const held = Array.from({ length: MAX_FILES }, (_, i) => fake(`h${i}.pdf`, 'application/pdf'))
    const result = acceptFiles(held, [fake('one-more.pdf', 'application/pdf')])

    assert.equal(result.files.length, MAX_FILES)
    assert.equal(result.rejected.length, 1)
  })

  it('reports only this drop, never an earlier one', () => {
    // The note under the composer is about the drop that just happened. Carrying
    // a previous refusal forward reads as a complaint about the new files.
    const first = acceptFiles([], [fake('clip.mp4', 'video/mp4')])
    const second = acceptFiles(first.files, [fake('q3.pdf', 'application/pdf')])
    assert.equal(second.rejected.length, 0)
  })
})

describe('namedForClipboard', () => {
  it('gives a pasted screenshot a name of its own', () => {
    // The clipboard calls every screenshot image.png, so four of them look like
    // one file pasted four times and three get deduped away.
    const named = namedForClipboard(fake('image.png', 'image/png'), 1700)
    assert.equal(named.name, 'pasted-1700.png')
    assert.equal(named.type, 'image/png')
  })

  it('leaves a real filename alone', () => {
    const named = namedForClipboard(fake('q3-report.pdf', 'application/pdf'), 1700)
    assert.equal(named.name, 'q3-report.pdf')
  })
})

describe('rejectionSentence', () => {
  it('says nothing when nothing was refused', () => {
    assert.equal(rejectionSentence([]), '')
  })

  it('reads as a sentence for one file', () => {
    assert.equal(
      rejectionSentence([{ name: 'clip.mp4', reason: 'too big' }]),
      'clip.mp4 — too big.',
    )
  })

  it('counts them when there are several', () => {
    const sentence = rejectionSentence([
      { name: 'a.mp4', reason: 'x' },
      { name: 'b.exe', reason: 'y' },
    ])
    assert.match(sentence, /^2 files were not attached/)
    assert.match(sentence, /a\.mp4 \(x\)/)
  })
})

describe('formatBytes', () => {
  it('picks a unit a person would use', () => {
    assert.equal(formatBytes(900), '900 B')
    assert.equal(formatBytes(2_048), '2 KB')
    assert.equal(formatBytes(1_500_000), '1.4 MB')
    assert.equal(formatBytes(24 * 1_024 * 1_024), '24 MB')
  })
})

describe('a file the browser no longer holds', () => {
  it('is read the same way as one it does', () => {
    /* The transcript draws its chips from a description rather than a `File`,
       and it has to reach the same answer — a recording that shows a document
       icon in the message you sent is the composer and the thread disagreeing
       about what you attached. */
    assert.equal(kindOfSent({ name: 'a.png', mime: 'image/png', bytes: 1, outcome: 'file' }), 'image')
    assert.equal(kindOfSent({ name: 'memo.m4a', mime: '', bytes: 1, outcome: 'audio' }), 'audio')
    assert.equal(kindOfSent({ name: 'q3.pdf', mime: '', bytes: 1, outcome: 'file' }), 'doc')
  })

  it('describes what the composer is holding without keeping hold of it', () => {
    const sent = sentFrom(fake('q3.pdf', 'application/pdf', 8_100))
    assert.deepEqual(sent, { name: 'q3.pdf', mime: 'application/pdf', bytes: 8_100, outcome: 'file' })
  })
})
