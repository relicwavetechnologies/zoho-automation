import type { HighlighterCore } from 'shiki/core';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

type Lang = string;

let highlighterPromise: Promise<HighlighterCore> | null = null;

function loadHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = createHighlighterCore({
    themes: [import('shiki/themes/vitesse-dark.mjs')],
    langs: [
      import('shiki/langs/typescript.mjs'),
      import('shiki/langs/javascript.mjs'),
      import('shiki/langs/tsx.mjs'),
      import('shiki/langs/jsx.mjs'),
      import('shiki/langs/json.mjs'),
      import('shiki/langs/bash.mjs'),
      import('shiki/langs/shellscript.mjs'),
      import('shiki/langs/python.mjs'),
      import('shiki/langs/sql.mjs'),
      import('shiki/langs/html.mjs'),
      import('shiki/langs/css.mjs'),
      import('shiki/langs/markdown.mjs'),
      import('shiki/langs/yaml.mjs'),
      import('shiki/langs/diff.mjs'),
    ],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  });
  return highlighterPromise;
}

/** Returns highlighted HTML string. Falls back to escaped plain text if Shiki errors. */
export async function highlightCode(code: string, lang: Lang | undefined): Promise<string> {
  try {
    const hl = await loadHighlighter();
    const resolved = resolveLang(hl, lang);
    return hl.codeToHtml(code, {
      lang: resolved,
      theme: 'vitesse-dark',
      transformers: [
        {
          pre(node) {
            node.properties.class = `${(node.properties.class as string) ?? ''} divo-shiki`.trim();
            // strip inline background; we apply our own via Tailwind
            const style = (node.properties.style as string) ?? '';
            node.properties.style = style.replace(/background-color:[^;]+;?/g, '');
          },
        },
      ],
    });
  } catch {
    return `<pre class="divo-shiki"><code>${escapeHtml(code)}</code></pre>`;
  }
}

function resolveLang(hl: HighlighterCore, lang: Lang | undefined): string {
  const loaded = new Set(hl.getLoadedLanguages());
  if (!lang) return 'text';
  const aliases: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    rb: 'ruby',
    sh: 'bash',
    zsh: 'bash',
    plaintext: 'text',
    text: 'text',
  };
  const norm = (aliases[lang] ?? lang).toLowerCase();
  return loaded.has(norm) ? norm : 'text';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default:  return '&#39;';
    }
  });
}
