/**
 * Streamdown ships Tailwind utility classes on every markdown node
 * (`text-3xl` headings, bordered tables, chunky inline code). Those utilities
 * beat `.markdown { … }` rules, so chat looked "stuck" on the cheap defaults.
 *
 * These components replace Streamdown's element map with bare semantic tags
 * (plus data-streamdown hooks). Visual design lives in `styles/markdown.css`.
 *
 * Do NOT override `code` / `pre` — Streamdown's code plugin owns fenced Shiki
 * blocks. Inline code is restyled via `[data-streamdown="inline-code"]` CSS.
 */

import type { Components, ExtraProps } from 'react-markdown'
import type { HTMLAttributes, ReactNode } from 'react'
import { MarkdownTable } from '@/components/MarkdownTable'
import { MarkdownLink } from '@/components/MarkdownLink'
import { CitationLink } from '@/components/CitationLink'

type MdProps<T extends HTMLElement> = HTMLAttributes<T> &
  ExtraProps & { children?: ReactNode }

function strip({
  node: _node,
  className: _className,
  ...props
}: MdProps<HTMLElement>) {
  return props
}

export const elegantMarkdownComponents: Components = {
  h1: (props) => (
    <h1 {...strip(props)} data-streamdown="heading-1">
      {props.children}
    </h1>
  ),
  h2: (props) => (
    <h2 {...strip(props)} data-streamdown="heading-2">
      {props.children}
    </h2>
  ),
  h3: (props) => (
    <h3 {...strip(props)} data-streamdown="heading-3">
      {props.children}
    </h3>
  ),
  h4: (props) => (
    <h4 {...strip(props)} data-streamdown="heading-4">
      {props.children}
    </h4>
  ),
  h5: (props) => (
    <h5 {...strip(props)} data-streamdown="heading-5">
      {props.children}
    </h5>
  ),
  h6: (props) => (
    <h6 {...strip(props)} data-streamdown="heading-6">
      {props.children}
    </h6>
  ),
  p: (props) => <p {...strip(props)}>{props.children}</p>,
  strong: (props) => (
    <strong {...strip(props)} data-streamdown="strong">
      {props.children}
    </strong>
  ),
  em: (props) => <em {...strip(props)}>{props.children}</em>,
  ul: (props) => (
    <ul {...strip(props)} data-streamdown="unordered-list">
      {props.children}
    </ul>
  ),
  ol: (props) => (
    <ol {...strip(props)} data-streamdown="ordered-list">
      {props.children}
    </ol>
  ),
  li: (props) => (
    <li {...strip(props)} data-streamdown="list-item">
      {props.children}
    </li>
  ),
  blockquote: (props) => (
    <blockquote {...strip(props)} data-streamdown="blockquote">
      {props.children}
    </blockquote>
  ),
  hr: (props) => <hr {...strip(props)} data-streamdown="horizontal-rule" />,
  a: (props) => {
    const { href, children, className } = props
    if (typeof href === 'string' && href.startsWith('#cite-')) {
      return (
        <CitationLink href={href} className={className}>
          {children}
        </CitationLink>
      )
    }
    return (
      <MarkdownLink href={href} className={className}>
        {children}
      </MarkdownLink>
    )
  },
  table: MarkdownTable,
  thead: (props) => (
    <thead {...strip(props)} data-streamdown="table-header">
      {props.children}
    </thead>
  ),
  tbody: (props) => (
    <tbody {...strip(props)} data-streamdown="table-body">
      {props.children}
    </tbody>
  ),
  tr: (props) => (
    <tr {...strip(props)} data-streamdown="table-row">
      {props.children}
    </tr>
  ),
  th: (props) => (
    <th {...strip(props)} data-streamdown="table-header-cell">
      {props.children}
    </th>
  ),
  td: (props) => (
    <td {...strip(props)} data-streamdown="table-cell">
      {props.children}
    </td>
  ),
}
