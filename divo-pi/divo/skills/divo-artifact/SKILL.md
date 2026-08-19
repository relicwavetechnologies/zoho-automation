---
name: divo-artifact
description: Use when a deliverable is worth presenting rather than pasting — a report, comparison, analysis, plan, or anything with tables, figures, or several sections. Covers writing the document as HTML and badging it into the panel beside the chat.
---

# Divo Documents

A document opens in a panel beside the conversation. It is for work the reader will come
back to: a report, an analysis, a comparison, a plan, a set of findings. Short answers,
status updates, confirmations, and a single next step stay in the chat.

This skill exists on the web surface only. If you are reading it, the panel is there.

## The two formats

**HTML (`.html`) is the default.** It renders as a designed document — cards, tables, stat
rows, charts. Use it for anything with structure or figures.

**Markdown (`.md`)** is for a document that is genuinely only prose and headings, where
structure would be decoration.

## Writing one

1. Create the file with `write`, under `artifacts/` — `artifacts/q4-flavour-review.html`.
2. Call `divo_artifact` with the path. That badges it into the panel; it does not write
   content.
3. Reply in chat with a one or two sentence pointer. Never paste the document body into the
   transcript — it is already on the reader's screen.

Revise with `edit` and call `divo_artifact` again on the same path. The panel updates the
document in place and bumps its version, so the reader keeps their scroll position and their
tab. Do not write a second file for a second draft.

## What goes in the file

**Body markup only.** No `<!doctype>`, no `<html>`, no `<head>`, no `<body>`. The runtime
wraps the file at render time and supplies the design tokens and the chart function. A
document that ships its own wrapper is a document that cannot follow the reader's theme.

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
