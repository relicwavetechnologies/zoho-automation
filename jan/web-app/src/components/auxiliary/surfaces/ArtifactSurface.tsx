import { useMemo, useState } from 'react'
import { CodeIcon, EyeIcon } from 'lucide-react'
import type { ArtifactTab } from '@/lib/auxiliary/types'
import { CodeBlock } from '@/components/ai-elements/code-block'
import type { BundledLanguage } from 'shiki'
import { cn } from '@/lib/utils'
import { RenderMarkdown } from '@/containers/RenderMarkdown'

type View = 'preview' | 'code'

function buildCsp(allowScripts: boolean): string {
  if (!allowScripts) {
    return [
      "default-src 'none'",
      'img-src data: blob:',
      "style-src 'unsafe-inline'",
      'font-src data:',
      "connect-src 'none'",
    ].join('; ')
  }
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
  ].join('; ')
}

function buildSrcDoc(code: string, allowScripts: boolean): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(allowScripts)}">`
  return `<!doctype html><html><head>${meta}</head><body>${code}</body></html>`
}

function isHtmlLike(tab: ArtifactTab): boolean {
  return tab.mime === 'text/html' || tab.mime === 'image/svg+xml'
}

export function ArtifactSurface({ tab }: { tab: ArtifactTab }) {
  const htmlLike = isHtmlLike(tab)
  const [view, setView] = useState<View>(htmlLike ? 'preview' : 'preview')
  const allowScripts = tab.mime !== 'image/svg+xml'

  const srcDoc = useMemo(() => {
    if (!htmlLike || view !== 'preview') return ''
    return buildSrcDoc(tab.content, allowScripts)
  }, [htmlLike, view, tab.content, allowScripts])

  const language = (tab.language ??
    (tab.mime === 'text/html'
      ? 'html'
      : tab.mime === 'image/svg+xml'
        ? 'xml'
        : tab.mime === 'text/markdown'
          ? 'markdown'
          : 'text')) as BundledLanguage

  const tabClass = (active: boolean) =>
    cn(
      'flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium transition-colors',
      active
        ? 'text-foreground border-b-2 border-primary'
        : 'text-muted-foreground hover:text-foreground border-b-2 border-transparent'
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex shrink-0 items-center gap-1 border-b border-border/70 px-2"
        role="tablist"
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === 'preview'}
          className={tabClass(view === 'preview')}
          onClick={() => setView('preview')}
        >
          <EyeIcon size={12} />
          Preview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'code'}
          className={tabClass(view === 'code')}
          onClick={() => setView('code')}
        >
          <CodeIcon size={12} />
          Source
        </button>
        <span className="ml-auto pr-2 font-mono text-[10px] text-muted-foreground/70">
          {tab.mime}
          {tab.version ? ` · v${tab.version}` : ''}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {view === 'preview' ? (
          htmlLike ? (
            <iframe
              title={tab.title}
              className="h-full min-h-[320px] w-full border-0 bg-white"
              sandbox={allowScripts ? 'allow-scripts' : ''}
              referrerPolicy="no-referrer"
              srcDoc={srcDoc}
            />
          ) : (
            <div className="px-5 py-5 text-sm leading-relaxed">
              <RenderMarkdown content={tab.content} />
            </div>
          )
        ) : (
          <div className="p-2">
            <CodeBlock code={tab.content} language={language} />
          </div>
        )}
      </div>
    </div>
  )
}
