# Divo Document Design

The design language for HTML artifacts — the documents that open in the panel beside the
conversation.

## Overview

A Divo document is a **dense, quiet, instrument-panel** surface. It is not a web page and
not a report cover. It renders in a side panel between roughly 380px and 900px wide, next
to a live conversation, and it is read the way someone reads a dashboard: scanned first,
then read in one or two places.

Everything follows from that. There is no hero, no title slab, no full-bleed colour band,
no 96px section rhythm, no centred 700px prose column. Those are page-scale devices and
they waste a panel. The document opens with its first real content within one line of the
top.

The atmosphere is `{colors.canvas}` — a near-white (near-black in dark) plane — carrying
white `{colors.surface}` cards that are separated from it by **a one-pixel ring, not a
shadow**. Type is small and tight: 12px to 13px does almost all the work, and the largest
thing on the page is 19px. Nothing is bold; `500` is the heaviest weight in the body and
`600` appears only on a card's own title.

Colour is **categorical, never decorative**. Every colour on the page means something
specific and comes from a fixed dictionary — a status, a category, a direction of change.
A colour used because a section needed some life is off-language. The page's default state
is grey ink on a white card, and colour is what breaks that pattern when something is
actually true.

**Key Characteristics:**

- Depth is a ring: `{elevation.card}` is `0 0 0 1px` plus at most a hint of lift. Cards sit
  on the page; they never float above it.
- The heaviest weight in running content is `500`. `600` is reserved for a card's own
  title. `700` appears nowhere.
- Every number carries `font-variant-numeric: tabular-nums`. Columns of figures must align.
- Colour arrives as a **6px dot** or a **14px badge square**, almost never as coloured text.
  The exceptions are `{colors.green}` / `{colors.red}` on a diff row and a delta figure.
- The signature easing is `cubic-bezier(0.23, 1, 0.32, 1)`. It is the only curve in the
  system apart from the drawer's `cubic-bezier(0.16, 1, 0.3, 1)`.
- Radius is hierarchical: `{rounded.card}` (12px) for cards, `{rounded.control}` (8px) for
  buttons, `{rounded.pill}` for tags and chips, `{rounded.badge}` (4–5px) for count badges.
- Card anatomy is always the same three parts: a **bar**, a **body**, and an optional
  **footer** on `{colors.inset}`.
- Tables are the primary shape. A Divo document that has data in it shows a table, not a
  paragraph describing the table.

## Colors

All colours are CSS variables supplied by the runtime. **Always use `var(--token)`; never
write a hex code for anything in this section.** The document inherits the app's light and
dark theme through these variables, and a hard-coded hex is a document that is unreadable
in one of the two themes.

### Surfaces

- **Canvas** (`{colors.canvas}` — `var(--canvas)`): The document's floor. The `<body>`
  background. Never put content directly on it without a card unless it is a heading or a
  paragraph of running prose.
- **Surface** (`{colors.surface}` — `var(--surface)`): The card plane. Every card, table,
  and panel sits on this.
- **Inset** (`{colors.inset}` — `var(--inset)`): A recessed plane. Card footers, drawer
  interiors, and the "other options" region. Reads as one step *below* the surface.
- **Field** (`{colors.field}` — `var(--field)`): The strongest neutral fill. Count badges
  inside an active chip, skeleton bars, meter tracks.
- **Hover** (`{colors.hover}` — `var(--hover)`): The row and control hover fill. This is the
  *only* hover treatment in the system — never a border change, never a transform.

### Ink

Three weights, and they are a hierarchy, not three greys to choose between.

- **Ink** (`{colors.ink}` — `var(--ink)`): Headings, the primary value in a row, an active
  label. The thing being read.
- **Ink 2** (`{colors.ink-2}` — `var(--ink-2)`): Running body copy, secondary cells, the
  supporting half of a pair.
- **Ink 3** (`{colors.ink-3}` — `var(--ink-3)`): Column headers, meta text, counts,
  timestamps, "no data" placeholders. The thing being skipped.

### Lines

- **Line** (`{colors.line}` — `var(--line)`): Every ordinary divider — table rows, card
  bars, section rules.
- **Line Strong** (`{colors.line-strong}` — `var(--line-strong)`): Control outlines and the
  unfilled segment of a meter. Slightly more present, used where an edge is an affordance
  rather than a separation.

### Semantic

These three are the only colours that may be used as **text**.

- **Green** (`{colors.green}` — `var(--green)`): An increase, a healthy state, an added row.
  Paired with `{colors.green-tint}` (`var(--green-tint)`) as a row background.
- **Red** (`{colors.red}` — `var(--red)`): A decrease, a failure, a removed row. Paired with
  `{colors.red-tint}` (`var(--red-tint)`).
- **Orange** (`{colors.orange}` — `var(--orange)`): Attention, pending, needs review. Paired
  with `{colors.orange-tint}` (`var(--orange-tint)`).

Green is not "good" and red is not "bad" — they are **direction**. A cost that fell is
green even when the fall is alarming; write the interpretation in words, not in hue.

### Accent

- **Accent** (`{colors.accent}` — `var(--accent)`): Ink, not a brand colour. The filled
  button, the active tab underline.
- **Accent Tint** (`{colors.accent-tint}` — `var(--accent-tint)`) and **Accent Ink**
  (`{colors.accent-ink}` — `var(--accent-ink)`): The pair used for inline `<code>` and
  highlighted values inside a sentence.
- **Link** (`{colors.link}` — `var(--link)`): The one blue on the surface. Inline links
  only. Nothing that is not clickable may be this colour.

### Categorical Palette

Eight hues for classifying things — categories, tags, series in a chart, sources. They are
**not** semantic: `{colors.cat-violet}` does not mean anything on its own, it means "this is
a different category from the orange one".

| Token | Value | Typical use |
|---|---|---|
| `{colors.cat-orange}` | `var(--cat-orange)` `#f09a2f` | First category, pending status |
| `{colors.cat-cyan}` | `var(--cat-cyan)` `#16a6c7` | Second category, in-progress status |
| `{colors.cat-green}` | `var(--cat-green)` `#25a878` | Third category, completed status |
| `{colors.cat-lime}` | `var(--cat-lime)` `#92b72d` | Fourth category |
| `{colors.cat-blue}` | `var(--cat-blue)` `#3f78ff` | Fifth category |
| `{colors.cat-violet}` | `var(--cat-violet)` `#9a5cff` | Sixth category |
| `{colors.cat-rose}` | `var(--cat-rose)` `#ee6572` | Seventh category |
| `{colors.cat-magenta}` | `var(--cat-magenta)` `#c84f9d` | Eighth category |
| `{colors.cat-grey}` | `var(--cat-grey)` `#7f858d` | Unclassified / fallback |

**Rules for this palette:**

1. Assign in the order above. The first distinct category in a document gets orange, the
   second cyan, and so on. Do not pick by association ("finance should be green").
2. It appears as a **6px dot** or a **14px rounded square badge**. Not as text, not as a
   large fill, not as a card background.
3. One category keeps its colour for the whole document. If "Wholesale" is cyan in the
   table it is cyan in the chart legend too.
4. Never more than eight. If there are more categories than that, the document should group
   them, not invent a ninth hue.

## Typography

### Font Family

`Geist, Inter, system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif` — supplied by
the runtime on `<body>`. Do not declare a font family; do not load a webfont. There is no
network inside a document.

Monospace is `"JetBrains Mono", ui-monospace, Menlo, monospace`, used for identifiers,
inline `<code>`, and any value the reader might copy.

### Hierarchy

The scale is deliberately fine-grained and lives largely between 11px and 13px. Half-pixel
steps are intentional — they are how the system separates two levels of meta text without
introducing another weight or colour.

| Token | Size | Weight | Line height | Use |
|---|---|---|---|---|
| `{typography.doc-title}` | 19px | 600 | 1.3 | The document's `<h1>`. One per document. |
| `{typography.section}` | 15px | 600 | 1.35 | `<h2>` — a major division of the document |
| `{typography.subsection}` | 13.5px | 600 | 1.4 | `<h3>` — a heading inside a section |
| `{typography.body}` | 13.5px | 400 | 1.65 | Running prose paragraphs |
| `{typography.card-title}` | 13px | 600 | 1.4 | A card's own title, in its bar |
| `{typography.row-primary}` | 13px | 500 | 1.4 | The identifying value in a table row |
| `{typography.card-body}` | 12.5px | 400 | 1.55 | Copy inside a card |
| `{typography.control}` | 12.5px | 500 | 1.4 | Button and chip labels |
| `{typography.cell}` | 12px | 400 | 1.4 | Ordinary table cells |
| `{typography.column}` | 11.5px | 500 | 1.4 | Table column headers |
| `{typography.tag}` | 11.5px | 500 | 1.4 | Tag and status pill labels |
| `{typography.meta}` | 11px | 400 | 1.4 | Captions, footnotes, drawer headings |
| `{typography.badge}` | 10.5px | 500 | 1 | Count badges inside a chip |
| `{typography.stat-value}` | 22px | 500 | 1.15 | The number in a stat block |

### Principles

**Emphasis comes from size and colour, never from weight.** The system tops out at `600`
and uses it in exactly two places: headings and a card's title. A sentence that needs a word
emphasised uses `{colors.ink}` against `{colors.ink-2}` copy, or wraps the word in the
`{component.value}` treatment — not `<strong>`.

**Every number is tabular.** Any element containing a figure gets
`font-variant-numeric: tabular-nums`. A column of right-aligned numbers that jitters between
rows is the single most visible failure in this system.

**Prose is a guest.** A Divo document is mostly structure. Paragraphs exist to say what the
structure means — two or three sentences, then back to a table, a stat row, or a chart. A
document that is four paragraphs long should have been a chat message.

## Layout

### Spacing

Base unit is 2px; the usable scale is:

`{spacing.xxs}` 4px · `{spacing.xs}` 6px · `{spacing.sm}` 8px · `{spacing.md}` 12px ·
`{spacing.lg}` 16px · `{spacing.xl}` 20px · `{spacing.section}` 28px

- **Document padding:** `{spacing.xl}` (20px) on all sides. Never more — horizontal padding
  is the most expensive thing in a panel.
- **Between sections:** `{spacing.section}` (28px). This is the document's vertical rhythm
  constant, and it is small on purpose. A panel does not breathe like a page.
- **Card padding:** `{spacing.md}` (12px) horizontal, `{spacing.sm}`–`{spacing.md}` vertical.
- **Table cell padding:** 8px vertical, 12px horizontal.
- **Between cards in a stack:** `{spacing.sm}` (8px).

### Width

The document is **fluid and narrow**. Assume 380px at the low end.

- Never set a fixed pixel width on a container.
- Never assume more than one column is available. Multi-column layouts must be built with
  `grid-template-columns: repeat(auto-fit, minmax(150px, 1fr))` so they collapse on their
  own.
- Two columns is the practical maximum for cards. Three only for compact stat blocks.
- A wide table does not shrink — it scrolls. Wrap it in `{component.scroll-x}`.

### Document Order

A Divo document reads top to bottom in this order, and sections are omitted rather than
reordered:

1. `<h1>` — what this is. One line, no subtitle slab.
2. One or two sentences of orientation. What the reader is looking at and why it exists.
3. The **headline numbers** — a `{component.stat-row}` if there are figures that matter.
4. The **evidence** — tables, charts, cards. The bulk of the document.
5. The **caveats** — what is missing, unverified, or estimated. Always present when any
   number was derived rather than read.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Flat | No ring, no shadow | Prose, headings, the document body itself |
| Hairline | `0 0 0 1px var(--line)` | Cards, tables, inset pills |
| Control | `0 0 0 1px var(--line-strong)` plus a hint of lift | Buttons, active chips |
| Tinted row | A `*-tint` background, no ring | Diff rows, highlighted table rows |

The philosophy is **ring-first**. There is no blur-radius shadow anywhere in this system
except the 1px lift beneath a control, and in dark mode even that goes away — planes are
separated by value instead. Do not write `box-shadow: 0 4px 12px rgba(0,0,0,.1)`. It reads
as a different product immediately.

## Shapes

| Token | Value | Use |
|---|---|---|
| `{rounded.card}` | 12px | Cards, tables, chart containers |
| `{rounded.control}` | 8px | Buttons, tabs, larger inline controls |
| `{rounded.badge}` | 5px | Status pills, count badges, code spans |
| `{rounded.chip}` | 4px | The smallest inline badge |
| `{rounded.pill}` | 9999px | Tags, filter chips, source chips |
| `{rounded.full}` | 50% | Dots, avatars |

A dot is always 6px. A category badge square is always 14px with `{rounded.chip}`.

## Components

Each entry below is a recipe. Write the markup and the CSS into the document — the runtime
supplies tokens and the chart function, nothing else. Keep all CSS in a single `<style>`
block at the top of the document.

### `stat-row`

The headline figures. Two to four across, collapsing on their own. Each tile is a label, a
number, and a change — and the change is split in two: the movement on the left in its
direction's colour, what it moved *from* on the right in muted ink.

```html
<div class="stat-row">
  <div class="stat">
    <span class="stat-label">Attributed revenue</span>
    <span class="stat-value">$18,420</span>
    <span class="stat-foot">
      <span class="delta up">&#9650; +24.1%</span>
      <span class="stat-vs">vs $14,850</span>
    </span>
  </div>
  <div class="stat">
    <span class="stat-label">Return on spend</span>
    <span class="stat-value">2.7&times;</span>
    <span class="stat-foot">
      <span class="delta down">&#9660; &minus;0.4</span>
      <span class="stat-vs">vs 3.1&times;</span>
    </span>
  </div>
  <div class="stat">
    <span class="stat-label">Cost per post</span>
    <span class="stat-value">$142</span>
    <span class="stat-foot">
      <span class="delta flat">&#9679; No change</span>
      <span class="stat-vs">vs $142</span>
    </span>
  </div>
</div>
```

```css
.stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 8px; margin: 16px 0; }
.stat { background: var(--surface); border-radius: var(--r-card);
        box-shadow: 0 0 0 1px var(--line); padding: 12px; display: flex;
        flex-direction: column; gap: 4px; }
.stat-label { font-size: 11.5px; font-weight: 500; color: var(--ink-3); }
.stat-value { font-size: 22px; font-weight: 500; color: var(--ink);
              font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.stat-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.delta { font-size: 11px; font-weight: 500; font-variant-numeric: tabular-nums; }
.delta.up { color: var(--green); } .delta.down { color: var(--red); }
.delta.flat { color: var(--ink-3); }
.stat-vs { margin-left: auto; font-size: 11px; color: var(--ink-3);
           font-variant-numeric: tabular-nums; }
```

Use a minus sign (`&minus;`, U+2212) rather than a hyphen in negative figures. A hyphen at
22px reads as a dash between two things.

**A falling number is not automatically red.** `up` and `down` mark direction, not judgement
— a cost that fell is `down` and still good news. Say which it is in words; do not rely on
the colour to carry the verdict. Use `flat` when nothing moved, rather than omitting the row
— a tile with no footer looks unfinished next to three that have one.

### `share-list`

The rows under a `{component.chart}` of type `hex`: each category with its share and its
figure. The cluster carries the proportion; this carries the numbers.

```html
<ul class="share-list">
  <li>
    <i class="dot" style="background: var(--cat-blue)"></i>
    <span class="share-name">Stir in strength</span>
    <span class="share-pct">51%</span>
    <span class="share-value up">&#9650; $3,420</span>
  </li>
  <li>
    <i class="dot" style="background: var(--cat-green)"></i>
    <span class="share-name">Iron boost Q3</span>
    <span class="share-pct">12%</span>
    <span class="share-value down">&#9660; $840</span>
  </li>
</ul>
```

```css
.share-list { list-style: none; margin: 12px 0; padding: 0; background: var(--surface);
              border-radius: var(--r-card); box-shadow: 0 0 0 1px var(--line);
              overflow: hidden; }
.share-list li { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
                 border-bottom: 1px solid var(--line); font-size: 12.5px; }
.share-list li:last-child { border-bottom: 0; }
.share-name { color: var(--ink); font-weight: 500; min-width: 0;
              overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.share-pct { font-size: 11px; font-weight: 500; color: var(--ink-2);
             background: var(--field); border-radius: 4px; padding: 1px 5px;
             font-variant-numeric: tabular-nums; }
.share-value { margin-left: auto; font-weight: 500; font-variant-numeric: tabular-nums;
               color: var(--ink); }
.share-value.up { color: var(--green); } .share-value.down { color: var(--red); }
```

### `progress`

A budget or quota, drawn as discrete ticks rather than a solid bar — the segments make a
part-used figure countable instead of merely approximate, which is the difference between
"about a third" and "31%".

```html
<div class="progress" style="--used: 96%; --fill: var(--orange)">
  <span class="progress-label">96% used</span>
  <span class="progress-track"><span class="progress-fill"></span></span>
</div>
```

```css
.progress { display: flex; flex-direction: column; gap: 4px; min-width: 90px; }
.progress-label { font-size: 12px; font-weight: 500; color: var(--ink);
                  font-variant-numeric: tabular-nums; }
.progress-track { position: relative; height: 8px; border-radius: 2px; overflow: hidden;
                  background: repeating-linear-gradient(90deg,
                    var(--line-strong) 0 2px, transparent 2px 4px); }
.progress-fill { position: absolute; inset: 0; width: var(--used);
                 background: repeating-linear-gradient(90deg,
                   var(--fill) 0 2px, transparent 2px 4px); }
```

Set `--fill` by state, not by size: `var(--green)` comfortable, `var(--orange)` tight,
`var(--red)` over. A bar at 96% of a budget that is meant to be spent is not a problem, so
choose the colour from what it means rather than from the percentage.

### `card`

The universal container. Three parts, always in this order, and the footer is optional.

```html
<div class="card">
  <div class="card-bar">
    <span class="card-title">Vendor onboarding rule</span>
    <span class="card-meta">290 characters</span>
  </div>
  <div class="card-body">
    <p>Cold-chain certification must be verified before a new dairy can be added.</p>
  </div>
  <div class="card-foot">
    <span class="chip"><span class="badge" style="background: var(--cat-rose)">PDF</span>
      Dairy Onboarding SOP.pdf</span>
  </div>
</div>
```

```css
.card { background: var(--surface); border-radius: var(--r-card);
        box-shadow: 0 0 0 1px var(--line); overflow: hidden; margin: 12px 0; }
.card-bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px;
            border-bottom: 1px solid var(--line); }
.card-title { font-size: 13px; font-weight: 600; color: var(--ink); }
.card-meta { margin-left: auto; font-size: 12px; color: var(--ink-3);
             font-variant-numeric: tabular-nums; }
.card-body { padding: 10px 12px; font-size: 12.5px; line-height: 1.55; color: var(--ink-2); }
.card-body p:first-child { margin-top: 0; } .card-body p:last-child { margin-bottom: 0; }
.card-foot { padding: 8px 12px; background: var(--inset);
             border-top: 1px solid var(--line); }
```

### `table`

The primary shape of the system.

```html
<div class="scroll-x">
  <table class="table">
    <thead>
      <tr><th>Flavor</th><th>Category</th><th class="num">Units</th><th>Status</th></tr>
    </thead>
    <tbody>
      <tr>
        <td class="primary">Pistachio</td>
        <td><span class="tag"><i class="dot" style="background: var(--cat-violet)"></i>Gelato</span></td>
        <td class="num">1,284</td>
        <td><span class="pill green">Completed</span></td>
      </tr>
    </tbody>
  </table>
</div>
```

```css
.scroll-x { overflow-x: auto; border-radius: var(--r-card);
            box-shadow: 0 0 0 1px var(--line); background: var(--surface); }
.table { width: 100%; border-collapse: collapse; font-size: 12px; }
.table th { text-align: left; font-size: 11.5px; font-weight: 500; color: var(--ink-3);
            padding: 8px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.table td { padding: 8px 12px; border-bottom: 1px solid var(--line); color: var(--ink-2); }
.table tr:last-child td { border-bottom: 0; }
.table tbody tr:hover { background: var(--hover); }
.table .primary { color: var(--ink); font-weight: 500; }
.table .num { text-align: right; font-variant-numeric: tabular-nums; }
```

**Every table needs a `<thead>`.** Column headers are `{colors.ink-3}` at `{typography.column}`
— they are scaffolding, not content. Right-align numeric columns and give them `.num`.

For a table with more than five columns, freeze the identifying column:

```css
.table .sticky { position: sticky; left: 0; background: var(--surface); z-index: 1; }
.table tbody tr:hover .sticky { background: var(--hover); }
```

### `tag` and `pill`

Two different things, and confusing them is the most common mistake.

A **tag** classifies — it names a category the thing belongs to. Dot plus ink label.
A **pill** states a workflow status — it is one of a small closed set. Tinted background.

```html
<span class="tag"><i class="dot" style="background: var(--cat-cyan)"></i>Wholesale</span>
<span class="pill orange">In review</span>
```

```css
.tag { display: inline-flex; align-items: center; gap: 6px; height: 20px; padding: 0 8px;
       border-radius: 9999px; background: var(--inset); box-shadow: 0 0 0 1px var(--line);
       font-size: 11.5px; font-weight: 500; color: var(--ink-2); white-space: nowrap; }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.pill { display: inline-flex; align-items: center; height: 20px; padding: 0 6px;
        border-radius: 5px; font-size: 11px; font-weight: 500; white-space: nowrap; }
.pill.green { background: var(--green-tint); color: var(--green); }
.pill.orange { background: var(--orange-tint); color: var(--orange); }
.pill.red { background: var(--red-tint); color: var(--red); }
.pill.grey { background: var(--field); color: var(--ink-2); }
```

The pill is the one place a semantic colour is used as text, and it is legible because it
sits on its own tint.

### `meter`

Three bars for a qualitative strength. Use when a value is ordinal but not numeric —
confidence, signal, connection strength.

```html
<span class="meter" aria-label="High confidence">
  <i class="on" style="background: var(--green)"></i>
  <i class="on" style="background: var(--green)"></i>
  <i class="on" style="background: var(--green)"></i>
</span>
```

```css
.meter { display: inline-flex; align-items: flex-end; gap: 2px; }
.meter i { width: 4px; height: 10px; border-radius: 2px; background: var(--line-strong); }
```

Filled segments take the colour; unfilled ones keep `{colors.line-strong}`. Always pair a
meter with its label in words — the bars alone do not say what three means.

### `diff-row`

An added or removed row inside a table.

```css
.table tr.added td { background: var(--green-tint); color: var(--green); }
.table tr.removed td { background: var(--red-tint); color: var(--red);
                       text-decoration: line-through;
                       text-decoration-color: color-mix(in srgb, var(--red) 50%, transparent); }
```

The strike-through is deliberately weakened to 50% so the text stays readable — a removal
still has to be legible to be reviewed.

### `note`

A caveat, a limitation, an assumption. Every document that derived a number needs one.

```html
<p class="note">Q4 figures are through Dec 18; the final two weeks are not in yet.</p>
```

```css
.note { font-size: 12px; color: var(--ink-3); border-left: 2px solid var(--line-strong);
        padding: 2px 0 2px 10px; margin: 12px 0; }
```

### `value`

A highlighted value inside running prose — an identifier, a setting, a quantity the sentence
turns on.

```html
<p>Reorder from <span class="value">cone_king</span> with a
   <span class="value">7 day</span> lead time.</p>
```

```css
.value { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: 12px;
         background: var(--accent-tint); color: var(--accent-ink);
         padding: 1px 5px; border-radius: 5px; }
```

### `scroll-x`

Any container wider than the panel. Wide tables, wide charts. Already defined under
`{component.table}` — reuse the same class.

**Nothing may cause the document body to scroll horizontally.** If content is wide, it
scrolls inside its own container.

## Charts

**Do not hand-write SVG for a chart.** Path data written by hand gets the y-scale, the
baseline, and the gridline alignment subtly wrong — the result looks plausible and is
incorrect, which is worse than no chart. Hexagonal packing and dot-grid sampling are worse
still: they are pure geometry and there is no way to eyeball whether they came out right.
The runtime draws all of them. You supply data.

The runtime finds every `.chart[data-chart]` and draws it. The attribute is JSON, so use
single quotes around it and double quotes inside.

Every chart takes `series`, and `color` on each series must come from the categorical
palette and must match the colour that category has everywhere else in the document.

### `line` · `area` — a value over time

```html
<div class="chart" data-chart='{
  "type": "line",
  "series": [
    {"label": "Pistachio", "color": "var(--cat-violet)", "points": [4, 9, 12, 18]},
    {"label": "Rocky road", "color": "var(--cat-orange)", "points": [2, -4, -8, -11]}
  ],
  "labels": ["Sep", "Oct", "Nov", "Dec"],
  "format": "percent"
}'></div>
```

`labels` is the x-axis. `format` is `number`, `percent`, or `currency`. The domain always
includes zero and the bounds round outward, so gridlines land on numbers a person would have
written down. Use for two or more series compared over the same period.

### `dot` — one series over time, as a field

The signature Divo time chart. An area chart stippled onto a grid of dots: each column
fills from the baseline up to its value, and the dots above stay pale so the empty space
still reads as part of the same field. Use it when there is **one** series and the shape of
the trend is the point — a revenue run, a volume ramp, a burn-down.

```html
<div class="chart" data-chart='{
  "type": "dot",
  "series": [{"label": "Attributed revenue", "color": "var(--cat-orange)",
              "points": [210, 240, 195, 305, 288, 340, 420, 460, 590, 640, 720, 910]}],
  "labels": ["Jul 6", "Jul 13", "Jul 20", "Jul 27", "Aug 6"],
  "format": "currency"
}'></div>
```

One series only — a second would overwrite the first's dots rather than layer over them. If
you have two series to compare over time, use `line`.

### `hex` — share of a whole

A proportional tile cluster. Every category holds a number of hexagons equal to its share,
filled from the centre outward with the **smallest share at the core** and the largest
forming the outer band. Use it for composition — where revenue came from, how a budget
split, which campaigns carry the load. It reads at a glance in a way a pie chart does not,
and unlike a pie it stays legible at four or five categories.

Each series carries a single `value` rather than `points`. The values do not need to sum to
100; they are normalised.

```html
<div class="chart" data-chart='{
  "type": "hex",
  "series": [
    {"label": "Stir in strength",   "color": "var(--cat-blue)",   "value": 3420},
    {"label": "Healthier every day","color": "var(--cat-orange)", "value": 1880},
    {"label": "Iron boost Q3",      "color": "var(--cat-green)",  "value": 840},
    {"label": "Ambassador program", "color": "var(--cat-violet)", "value": 610}
  ]
}'></div>
```

Pair it with a `{component.share-list}` underneath giving each category its exact figure —
the cluster carries the proportion, the list carries the numbers.

### `bar` — discrete comparison

For a handful of named things measured once, or two series side by side per label. Bars grow
from the zero line in both directions, so a negative value hangs below it correctly.

### Rules for every chart

- Wrap it in a `{component.card}` when it needs a title.
- **Always state the takeaway in a sentence** beside it. A chart is evidence for a claim; the
  claim goes in words, because the reader may be skimming and because a chart alone cannot be
  quoted back.
- Never use more than one chart to say the same thing twice.
- If there are four or fewer numbers, a `{component.stat-row}` beats a chart.

## Motion

Documents are re-opened and re-read. **Do not write entrance animations** — no fade-up on
load, no staggered reveal, no timed sequence. A reveal that plays every time the reader opens
a tab is a glitch, not a flourish.

The only motion is response to the reader:

- Row and control hover: `background-color 100ms ease`.
- Expand and collapse: `grid-template-rows: 0fr → 1fr` on a wrapper with an
  `overflow: hidden` child, `300ms cubic-bezier(0.23, 1, 0.32, 1)`.
- Press: `transform: scale(0.96)`, `100ms`.

Use `<details>`/`<summary>` for anything collapsible rather than scripting it.

## Interaction

A document is sandboxed. It has **no network access** — no `fetch`, no images from a URL, no
webfonts, no external stylesheets. Everything must be self-contained.

Interaction that works entirely inside the document is welcome and encouraged: sorting a
table, filtering rows with chips, expanding a `<details>`, switching tabs. Write it in a
plain `<script>` at the end of the body.

Interaction that implies an effect outside the document is **forbidden**. Do not draw an
"Approve", "Send", "Save", or "Delete" button. It cannot do anything, and a control that
looks live and is inert is worse than no control. If the document needs the reader to
decide something, say so in a sentence and let them answer in the chat.

## Do's and Don'ts

### Do

- Open with content. The first heading is on the first line.
- Lead with numbers when there are numbers — a `{component.stat-row}` before the prose.
- Use `var(--token)` for every colour, without exception.
- Put a `{component.note}` at the end whenever a figure was estimated, extrapolated, or is
  incomplete.
- Right-align and tabular-align every numeric column.
- Keep one category's colour consistent across the table, the chart, and the legend.
- Prefer a table over a list, and a list over a paragraph, whenever the content has
  structure.
- State the takeaway in words next to every chart.

### Don't

- Don't write a hex colour. The document must survive a theme switch.
- Don't add a shadow with a blur radius. Depth in this system is a 1px ring.
- Don't use `<strong>` or weight `700` for emphasis. Use `{colors.ink}` against
  `{colors.ink-2}`, or `{component.value}`.
- Don't build a hero, a cover, a title slab, or a centred masthead. The panel is 380px wide.
- Don't animate on load. Documents are re-read.
- Don't draw buttons that claim to act on the world.
- Don't hand-write chart SVG. Use `{component.chart}` — including for the hex cluster and
  the dot field, which are geometry you cannot check by eye.
- Don't draw a pie or a donut. Share of a whole is the `hex` cluster, and it stays readable
  at five categories where a pie does not.
- Don't put two series into a `dot` chart — the second overwrites the first. Two series over
  time is `line`.
- Don't use a chart for four or fewer numbers. That is a `{component.stat-row}`.
- Don't set a fixed pixel width on any container.
- Don't use the categorical palette as text or as a large fill — dots and 14px badges only.
- Don't pad like a web page. 20px document padding, 28px between sections, and no more.
- Don't fill a document with prose. If it is four paragraphs and no structure, it was a chat
  message.

## Responsive Behavior

There is one breakpoint that matters, and it is inside a panel, not a viewport.

| Width | Behavior |
|---|---|
| < 480px | Everything is one column. `{component.stat-row}` stacks. Tables scroll inside `{component.scroll-x}`. |
| 480–700px | Stat rows go two across. Cards stay full width. |
| > 700px | Stat rows go three or four across. Cards may pair. |

Build this with `minmax()` and `auto-fit` rather than media queries — the panel is resized by
dragging, continuously, and a media query on the viewport is measuring the wrong thing. If a
media query is genuinely needed, write it against a container query on the document root.

## Known Constraints

- No network of any kind. No remote images, fonts, scripts, or stylesheets.
- No `localStorage` or cookies — the document runs on an opaque origin.
- Documents are stored as the body only; the runtime supplies the wrapper, tokens, and chart
  function at render time. Do not write `<!doctype>`, `<html>`, `<head>`, or `<body>` tags.
- Maximum body size is 400,000 characters.
