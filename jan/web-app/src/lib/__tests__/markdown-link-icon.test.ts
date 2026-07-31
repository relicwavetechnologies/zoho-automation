import { describe, expect, it } from 'vitest'
import {
  ExternalLinkIcon,
  GithubIcon,
  MailIcon,
} from 'lucide-react'
import {
  GmailIcon,
  GoogleDocsIcon,
  GoogleSheetsIcon,
  LarkIcon,
  ZohoIcon,
} from '@/components/brand-icons'
import { resolveMarkdownLinkIcon } from '../markdown-link-icon'

describe('resolveMarkdownLinkIcon', () => {
  it('maps Google product hosts to local brand marks', () => {
    expect(resolveMarkdownLinkIcon('https://mail.google.com/mail/u/0')).toBe(
      GmailIcon
    )
    expect(
      resolveMarkdownLinkIcon(
        'https://docs.google.com/document/d/abc/edit'
      )
    ).toBe(GoogleDocsIcon)
    expect(
      resolveMarkdownLinkIcon(
        'https://docs.google.com/spreadsheets/d/abc/edit'
      )
    ).toBe(GoogleSheetsIcon)
  })

  it('maps Lark / Zoho / GitHub / mailto', () => {
    expect(resolveMarkdownLinkIcon('https://open.feishu.cn/docx/abc')).toBe(
      LarkIcon
    )
    expect(resolveMarkdownLinkIcon('https://crm.zoho.com/crm/org')).toBe(
      ZohoIcon
    )
    expect(resolveMarkdownLinkIcon('https://github.com/divo/repo')).toBe(
      GithubIcon
    )
    expect(resolveMarkdownLinkIcon('mailto:abhishek@emiactech.com')).toBe(
      MailIcon
    )
  })

  it('falls back to external-link for unknown http hosts', () => {
    expect(resolveMarkdownLinkIcon('https://email.openai.com/foo')).toBe(
      ExternalLinkIcon
    )
  })

  it('skips citations and invalid hrefs', () => {
    expect(resolveMarkdownLinkIcon('#cite-msg-1')).toBeUndefined()
    expect(resolveMarkdownLinkIcon('not a url')).toBeUndefined()
    expect(resolveMarkdownLinkIcon(undefined)).toBeUndefined()
  })
})
