import { describe, it, expect } from 'vitest'
import { ContentType } from '@janhq/core'
import { newUserThreadContent } from '../completion'
import type { Attachment } from '@/types/attachment'

describe('newUserThreadContent — audio attachments', () => {
  it('injects document paths into the user text for Pi skills', () => {
    const document: Attachment = {
      name: 'brief.pdf',
      type: 'document',
      path: '/Users/test/brief.pdf',
      fileType: 'pdf',
      size: 1234,
    }
    const msg = newUserThreadContent('t1', 'analyze this', [document], 'm1')
    const textPart = msg.content.find((c) => c.type === ContentType.Text) as any

    expect(textPart.text.value).toContain('[ATTACHED_FILES]')
    expect(textPart.text.value).toContain('name: brief.pdf')
    expect(textPart.text.value).toContain('path: /Users/test/brief.pdf')
  })

  it('injects image paths into the user text for local OCR skills', () => {
    const image: Attachment = {
      name: 'receipt.png',
      type: 'image',
      path: '/Users/test/receipt.png',
      base64: 'AAA',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AAA',
      size: 100,
    }
    const msg = newUserThreadContent('t1', 'analyze this image', [image], 'm1')
    const textPart = msg.content.find((c) => c.type === ContentType.Text) as any

    expect(textPart.text.value).toContain('[ATTACHED_FILES]')
    expect(textPart.text.value).toContain('name: receipt.png')
    expect(textPart.text.value).toContain('path: /Users/test/receipt.png')
    expect(textPart.text.value).toContain('type: image/png')
  })

  it('does not inject image metadata when an image has no local path', () => {
    const image: Attachment = {
      name: 'clipboard.png',
      type: 'image',
      base64: 'AAA',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AAA',
      size: 100,
    }
    const msg = newUserThreadContent('t1', 'analyze clipboard image', [image], 'm1')
    const textPart = msg.content.find((c) => c.type === ContentType.Text) as any

    expect(textPart.text.value).not.toContain('[ATTACHED_FILES]')
    expect(msg.content.map((c) => c.type)).toContain(ContentType.Image)
  })

  it('emits an input_audio content part for wav audio', () => {
    const audio: Attachment = {
      name: 'clip.wav',
      type: 'audio',
      base64: 'QUFB',
      audioFormat: 'wav',
      mimeType: 'audio/wav',
      dataUrl: 'data:audio/wav;base64,QUFB',
      size: 1024,
    }
    const msg = newUserThreadContent('t1', 'hello', [audio], 'm1')
    const audioPart = msg.content.find(
      (c) => c.type === ContentType.InputAudio
    ) as any
    expect(audioPart).toBeDefined()
    expect(audioPart.input_audio).toEqual({ data: 'QUFB', format: 'wav' })
  })

  it('emits an input_audio content part for mp3 audio', () => {
    const audio: Attachment = {
      name: 'song.mp3',
      type: 'audio',
      base64: 'WlpaWg==',
      audioFormat: 'mp3',
      mimeType: 'audio/mpeg',
      dataUrl: 'data:audio/mpeg;base64,WlpaWg==',
      size: 2048,
    }
    const msg = newUserThreadContent('t1', 'listen', [audio])
    const audioPart = msg.content.find(
      (c) => c.type === ContentType.InputAudio
    ) as any
    expect(audioPart.input_audio).toEqual({ data: 'WlpaWg==', format: 'mp3' })
  })

  it('skips audio attachments missing base64 or format', () => {
    const broken: Attachment = {
      name: 'broken.wav',
      type: 'audio',
      audioFormat: 'wav',
      mimeType: 'audio/wav',
      size: 10,
    }
    const msg = newUserThreadContent('t1', 'hi', [broken])
    expect(msg.content.some((c) => c.type === ContentType.InputAudio)).toBe(
      false
    )
  })

  it('coexists with text and image attachments', () => {
    const image: Attachment = {
      name: 'pic.png',
      type: 'image',
      base64: 'AAA',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AAA',
      size: 100,
    }
    const audio: Attachment = {
      name: 'clip.wav',
      type: 'audio',
      base64: 'QUFB',
      audioFormat: 'wav',
      mimeType: 'audio/wav',
      dataUrl: 'data:audio/wav;base64,QUFB',
      size: 1024,
    }
    const msg = newUserThreadContent('t1', 'with both', [image, audio], 'm1')
    const types = msg.content.map((c) => c.type)
    expect(types).toContain(ContentType.Text)
    expect(types).toContain(ContentType.Image)
    expect(types).toContain(ContentType.InputAudio)
  })
})
