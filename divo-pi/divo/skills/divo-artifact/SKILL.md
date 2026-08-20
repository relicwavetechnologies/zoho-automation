---
name: divo-artifact
description: Use when a deliverable is worth presenting rather than pasting — a report, comparison, analysis, plan, or anything with tables, figures, or several sections. Covers writing the document as HTML and filing it for the current surface.
---

# Divo Documents

A document is for work the reader will come back to: a report, an analysis, a comparison,
a plan, a set of findings. On the web it opens in a panel beside the conversation. On a
direct Lark message it is filed for link delivery. Short answers, status updates,
confirmations, and a single next step stay in the chat.

This skill exists on the web and direct-message Lark surfaces. Follow the current surface
descriptor rather than guessing from the channel name.

## The two formats

**HTML (`.html`) is the default.** It renders as a designed document — cards, tables, stat
rows, charts. Use it for anything with structure or figures.

**Markdown (`.md`)** is for a document that is genuinely only prose and headings, where
structure would be decoration.

## Writing one

1. Create the file with `write`, under `artifacts/` — `artifacts/q4-flavour-review.html`.
2. Call `divo_artifact` with the path. That files the existing document for the current
   surface; it does not write content.
3. Reply in chat with a one or two sentence pointer. Never paste the document body into the
   transcript — it is already available through the surface's delivery mode.

## Delivering a link

When the surface descriptor says `artifacts: 'link'`, call `divo_publish` with the
stored `artifactId` after `divo_artifact` succeeds. Speak the returned URL and the
one-time password in the reply. The password keeps a forwarded link from being readable
by whoever receives it; it is a latch, not security. When the descriptor says
`artifacts: 'inline'`, the panel is enough unless the reader asks for a link.

Revise with `edit` and call `divo_artifact` again on the same path. The stored document is
updated in place and its version advances. On the web the panel keeps its scroll position;
for a link surface, publish the updated artifact again. Do not write a second file for a
second draft.

## What goes in the file

**Body markup only.** No `<!doctype>`, no `<html>`, no `<head>`, no `<body>`. The document
renderer wraps the file at delivery time and supplies the design tokens and the chart
function. A document that ships its own wrapper is a document that cannot follow the
reader's theme.

Put the document's own CSS in a single `<style>` block at the top of the file, and any
interaction in a `<script>` at the end.

## Read the design spec first

**`DESIGN.md`, beside this file, is not optional.** Read it before writing the first HTML
document in a conversation. It carries the colour tokens, the type scale, the component
recipes, and the rules that make a document look like Divo rather than like a generic web
page.

Two rules from it are worth stating here because getting them wrong is expensive:

- **Never write a hex colour.** Every colour is `var(--token)`. A hard-coded colour is
  unreadable when the reader switches theme.
- **Never hand-write chart SVG.** Emit `<div class="chart" data-chart='…'>` with the data,
  and the runtime draws it. Hand-written path data gets the scale subtly wrong, which looks
  fine and misinforms.

## What a document is not

It has no network, no storage, and no way to act on anything. Do not draw an Approve, Send,
or Save button — it cannot work, and an inert control that looks live is worse than none. If
you need a decision from the reader, ask for it in the chat.

Do not use a document to restate a short answer at greater length. If there is no table, no
figure, and no section worth returning to, the answer was a chat message.
