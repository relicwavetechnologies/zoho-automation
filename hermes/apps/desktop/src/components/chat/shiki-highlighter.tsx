'use client'

import type { SyntaxHighlighterProps } from '@assistant-ui/react-streamdown'
import type { FC } from 'react'
import ShikiHighlighter from 'react-shiki'

import {
  CodeCard,
  CodeCardBody,
  CodeCardHeader,
  CodeCardIcon,
  CodeCardSubtitle,
  CodeCardTitle
} from '@/components/chat/code-card'
import { CopyButton } from '@/components/ui/copy-button'
import { codiconForLanguage, isLikelyProseCodeBlock, sanitizeLanguageTag } from '@/lib/markdown-code'

/**
 * Streamdown's code adapter renders header + body as inline siblings, so we
 * own the wrapping `<CodeCard>` here and neutralize the upstream
 * `data-streamdown="code-block"` chrome from styles.css. Anything that wants
 * a card-shaped code surface should compose `CodeCard*` directly.
 *
 * `react-shiki` full bundle so all `bundledLanguages` work; theme switches
 * follow the document `color-scheme` via `defaultColor="light-dark()"`.
 */
interface HermesSyntaxHighlighterProps extends SyntaxHighlighterProps {
  defer?: boolean
}

/**
 * Cursor-style near-monochrome code theme. Cursor's chat code blocks don't use
 * rainbow syntax highlighting — they render all code in a single warm
 * salmon-pink, with comments dimmed to a cool gray. We reproduce that with a
 * minimal custom theme: `editor.foreground` paints every token pink (since we
 * override nothing else), and only comment scopes are remapped to gray. The
 * background is transparent so the `CodeCard` surface shows through.
 */
const CURSOR_CODE_PINK_DARK = '#cd9883'
const CURSOR_CODE_PINK_LIGHT = '#a8543b'
const CURSOR_COMMENT_DARK = '#6b7280'
const CURSOR_COMMENT_LIGHT = '#8a8a8a'

// Minimal TextMate/VS Code theme shape Shiki accepts. Typed loosely because
// react-shiki re-exports Shiki's broad `ThemeRegistrationAny` union; a plain
// object literal structurally satisfies the raw-theme branch.
const makeMonochromeCodeTheme = (
  name: string,
  type: 'dark' | 'light',
  foreground: string,
  comment: string
) => ({
  name,
  type,
  colors: { 'editor.foreground': foreground, 'editor.background': '#00000000' },
  tokenColors: [
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.quoted.docstring'],
      settings: { foreground: comment, fontStyle: 'italic' }
    }
  ]
})

const SHIKI_THEME = {
  dark: makeMonochromeCodeTheme('cursor-code-dark', 'dark', CURSOR_CODE_PINK_DARK, CURSOR_COMMENT_DARK),
  light: makeMonochromeCodeTheme('cursor-code-light', 'light', CURSOR_CODE_PINK_LIGHT, CURSOR_COMMENT_LIGHT)
} as const

export const SyntaxHighlighter: FC<HermesSyntaxHighlighterProps> = ({
  components: { Pre },
  language,
  code,
  defer = false
}) => {
  const trimmed = (code ?? '').replace(/^\n+/, '').trimEnd()

  // Streaming may hand us empty/incomplete fences — render nothing rather
  // than a transient empty card.
  if (!trimmed.trim()) {
    return null
  }

  if (isLikelyProseCodeBlock(language, trimmed)) {
    return <div className="aui-prose-fence whitespace-pre-wrap wrap-anywhere text-foreground">{trimmed}</div>
  }

  const cleanLanguage = sanitizeLanguageTag(language || '')
  const label = cleanLanguage && cleanLanguage !== 'unknown' ? cleanLanguage : ''

  return (
    <CodeCard data-streaming={defer ? 'true' : undefined}>
      <CodeCardHeader>
        <CodeCardTitle>
          <CodeCardIcon name={codiconForLanguage(label)} />
          Code
          {label && <CodeCardSubtitle> · {label}</CodeCardSubtitle>}
        </CodeCardTitle>
        <CopyButton
          appearance="inline"
          className="-my-1 -mr-1 h-5 px-1 opacity-55 hover:opacity-100"
          iconClassName="size-2.5"
          label="Copy code"
          showLabel={false}
          text={trimmed}
        />
      </CodeCardHeader>
      <CodeCardBody>
        <Pre className="aui-shiki m-0 overflow-hidden bg-transparent p-0">
          {defer ? (
            <code className="block whitespace-pre">{trimmed}</code>
          ) : (
            <ShikiHighlighter
              addDefaultStyles={false}
              as="div"
              defaultColor="light-dark()"
              delay={120}
              language={language || 'text'}
              showLanguage={false}
              theme={SHIKI_THEME}
            >
              {trimmed}
            </ShikiHighlighter>
          )}
        </Pre>
      </CodeCardBody>
    </CodeCard>
  )
}
