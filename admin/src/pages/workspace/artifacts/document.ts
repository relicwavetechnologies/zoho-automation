/**
 * The wrapper a stored document is rendered inside.
 *
 * A document arrives as body markup and nothing else — the runtime never stores a
 * doctype, a head, or a palette. Everything structural is added here, at read
 * time, which is what makes two promises true at once:
 *
 *   **The reader's theme wins.** Colours resolve through `--ink`, `--surface`,
 *   `--line` and friends, defined below in both themes. A document written in
 *   June follows a palette retuned in August, because it never carried one.
 *
 *   **The document cannot reach anything.** The frame is sandboxed without
 *   `allow-same-origin`, so it runs on an opaque origin: no cookies, no storage,
 *   no same-origin fetch, no access to the app's DOM. The CSP below then removes
 *   the network entirely. Neither control depends on the other being right.
 *
 * The model is told to write body markup only. It is not trusted to — a document
 * that ships its own `<html>` still renders, because everything here is additive
 * and a nested document is just markup the browser flattens.
 */
import { CHART_GEOMETRY_SOURCE } from '@/lib/chart-geometry'

/**
 * No network of any kind.
 *
 * `connect-src 'none'` is the one that matters: it is what stops a document from
 * posting what it can see to somewhere else. The inline allowances are not a
 * weakening of that — a document *is* inline style and script, and on an opaque
 * origin with no connect there is nothing for that script to exfiltrate to.
 */
const POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "img-src data:",
  "font-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/**
 * What the frame may do.
 *
 * `allow-same-origin` is deliberately absent and is the whole security model —
 * with it, a document could read the app's cookies and call its API as the
 * reader. Popups are allowed so a source link behaves like a link; escaping the
 * sandbox applies to the window that opens, not to this one.
 */
export const DOCUMENT_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'

export type DocumentTheme = 'light' | 'dark'

/**
 * The palette, in the names the design spec teaches.
 *
 * The values are the app's — `src/styles/palette.css`, which holds Beautiful
 * UI's hexes — but they are written out here rather than imported, and that is
 * not an oversight. A document is a standalone HTML file: it is downloaded,
 * mailed, opened next year. It cannot resolve a variable that lives in a
 * stylesheet it was never shipped with.
 *
 * So this is a copy, and copies drift. `document.test.ts` compares it against
 * `palette.css` and fails when it does — the same arrangement the runtime uses
 * for the progress bounds that the container and the backend both have to know.
 *
 * Two values are deliberately NOT the palette's, and the test knows it:
 * `--accent` and `--accent-ink` are ink here. A document is a page of prose and
 * figures where nearly everything could argue for being the important one; the
 * app's blue is spent on links, and inline code takes a neutral fill instead.
 */
const LIGHT = `
  --canvas: #f1f2f3; --surface: #ffffff; --inset: #f7f8f9; --field: #f2f2f3;
  --hover: #f4f5f6;
  --ink: #1f2124; --ink-2: #62656b; --ink-3: #9a9da3;
  --line: #ecedef; --line-strong: #e0e2e5;
  --green: #189a4d; --green-tint: #e8f5ed;
  --red: #e3474c; --red-tint: #fcecec;
  --orange: #ef720c; --orange-tint: #fdf1e5;
  --accent: #1f2124; --accent-tint: #f2f2f3; --accent-ink: #1f2124;
  --link: #0170dd;
  --lift: 0 1px 2px #1018280a;
`

const DARK = `
  --canvas: #1c1d1f; --surface: #232427; --inset: #1f2022; --field: #2b2c2f;
  --hover: #2a2b2e;
  --ink: #f2f3f4; --ink-2: #a5a8ad; --ink-3: #6c6f75;
  --line: #2e3033; --line-strong: #3a3c40;
  --green: #3dbb72; --green-tint: #3dbb7224;
  --red: #ee5c61; --red-tint: #ee5c6124;
  --orange: #f68f3c; --orange-tint: #f68f3c24;
  --accent: #f2f3f4; --accent-tint: #2b2c2f; --accent-ink: #f2f3f4;
  --link: #7ec0ff;
  --lift: 0 1px 2px #0003;
`

/**
 * The categorical hues, identical in both themes.
 *
 * They classify rather than mean, so they must not drift between light and dark
 * — a series that is violet in one theme and lavender in the other is two
 * different series to a reader comparing two screenshots. They are legible in
 * both because the spec confines them to 6px dots and 14px badges, never text.
 */
const CATEGORICAL = `
  --cat-orange: #f09a2f; --cat-cyan: #16a6c7; --cat-green: #25a878;
  --cat-lime: #92b72d; --cat-blue: #3f78ff; --cat-violet: #9a5cff;
  --cat-rose: #ee6572; --cat-magenta: #c84f9d; --cat-grey: #7f858d;
`

/**
 * Base rules only.
 *
 * Enough that a document with no CSS of its own is still readable and still
 * looks like Divo — headings, prose, tables, code, links. Components are the
 * document's own business; the spec gives it the recipes.
 */
const BASE = `
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; padding: 20px;
    background: var(--canvas); color: var(--ink-2);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    font-size: 13.5px; line-height: 1.65;
    -webkit-font-smoothing: antialiased;
    overflow-wrap: break-word;
  }
  h1, h2, h3, h4 { color: var(--ink); font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  h1 { font-size: 19px; line-height: 1.3; }
  h2 { font-size: 15px; line-height: 1.35; margin-top: 28px; }
  h3 { font-size: 13.5px; line-height: 1.4; margin-top: 20px; }
  h4 { font-size: 12.5px; line-height: 1.4; margin-top: 16px; color: var(--ink-2); }
  h1 + p, h2 + p, h3 + p { margin-top: 6px; }
  :first-child { margin-top: 0; }
  p { margin: 10px 0; }
  ul, ol { margin: 10px 0; padding-left: 20px; }
  li { margin: 3px 0; }
  a { color: var(--link); text-decoration: underline;
      text-decoration-color: color-mix(in srgb, var(--link) 42%, transparent);
      text-underline-offset: 2px; }
  code { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: 12px;
         background: var(--accent-tint); color: var(--accent-ink);
         padding: 1px 5px; border-radius: 5px; }
  pre { background: var(--inset); box-shadow: 0 0 0 1px var(--line); border-radius: 12px;
        padding: 12px; overflow-x: auto; margin: 12px 0; }
  pre code { background: none; padding: 0; font-size: 12px; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 20px 0; }
  blockquote { margin: 12px 0; padding: 2px 0 2px 10px;
               border-left: 2px solid var(--line-strong); color: var(--ink-3); }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
  /* Numbers align by default. A document should not have to remember to ask. */
  td, th, .num, .tabular { font-variant-numeric: tabular-nums; }
  /* The panel is narrow and resized by dragging — nothing may push the body wide. */
  body > * { max-width: 100%; }
  ::-webkit-scrollbar { height: 8px; width: 8px; }
  ::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
`

/**
 * The chart renderer.
 *
 * This exists because a model hand-writing SVG path data gets the y-scale, the
 * baseline and the gridline alignment subtly wrong, and a chart that is subtly
 * wrong looks right — the one failure mode a reader cannot catch. So the
 * document supplies data and this draws it.
 *
 * Two choices worth naming. The domain always includes zero, because a line
 * chart cropped to its own range turns a 2% wobble into a cliff. And the bounds
 * are rounded outward to a "nice" step so gridlines land on numbers a person
 * would write down.
 *
 * Injected as source text rather than imported: it has to execute inside the
 * frame, which shares nothing with this bundle. Exported so a test can evaluate
 * it against a stub document and check the geometry it computes — the claim that
 * this draws charts correctly is worth more as an assertion than as a comment.
 */
export const CHART_RUNTIME = `
(function () {
  var NS = "http://www.w3.org/2000/svg";

  /* Where every mark goes, shared with the dashboard's own charts rather than
     written twice. The frame has no module system, so the geometry arrives as
     the text of the same functions React calls — see chart-geometry.ts. */
${CHART_GEOMETRY_SOURCE}

  function format(value, kind) {
    var rounded = Math.round(value * 100) / 100;
    if (kind === "percent") return rounded + "%";
    if (kind === "currency") return "$" + rounded.toLocaleString("en-US");
    return rounded.toLocaleString("en-US");
  }

  function el(name, attrs) {
    var node = document.createElementNS(NS, name);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  }

  function legendInto(host, series) {
    var legend = document.createElement("div");
    legend.className = "chart-legend";
    for (var g = 0; g < series.length; g++) {
      var item = document.createElement("span");
      var dot = document.createElement("i");
      dot.style.background = series[g].color || "var(--ink-3)";
      item.appendChild(dot);
      item.appendChild(document.createTextNode(series[g].label || ("Series " + (g + 1))));
      legend.appendChild(item);
    }
    host.appendChild(legend);
  }

  /* A pointy-top hexagon, which is the orientation that tiles into a blob
     rather than into visible vertical seams. */
  function hexPoints(x, y, radius) {
    var pts = [];
    for (var i = 0; i < 6; i++) {
      var angle = (Math.PI / 180) * (60 * i - 90);
      pts.push((x + radius * Math.cos(angle)).toFixed(1)
        + "," + (y + radius * Math.sin(angle)).toFixed(1));
    }
    return pts.join(" ");
  }

  /**
   * Share as tiles: every category holds a proportional number of hexagons.
   *
   * Filled from the centre outward in ascending order, so the smallest share
   * sits at the core and the largest forms the outer band. That ordering is
   * what makes the shape readable — filled in declaration order the regions
   * interleave and the picture stops meaning anything.
   */
  function drawHex(host, spec, series) {
    var values = series.map(function (one) { return Math.max(0, Number(one.value) || 0); });
    var total = values.reduce(function (sum, one) { return sum + one; }, 0);
    if (!(total > 0)) { host.textContent = "No data."; return; }

    var COLS = 26, ROWS = 17, R = 10;
    var cells = hexCells(COLS, ROWS, R);
    var owner = shareAssignment(values, cells.length, spec.density || 0.58);

    var svg = el("svg", {
      viewBox: "0 0 " + cells[0].width.toFixed(0) + " " + cells[0].height.toFixed(0),
      role: "img",
      style: "width:100%;height:auto;display:block"
    });
    for (var c = 0; c < cells.length; c++) {
      svg.appendChild(el("polygon", {
        points: hexPoints(cells[c].x, cells[c].y, R - 1.2),
        fill: owner[c] >= 0 ? (series[owner[c]].color || "var(--ink-3)") : "var(--field)"
      }));
    }

    host.textContent = "";
    legendInto(host, series);
    host.appendChild(svg);
  }

  function draw(host) {
    var spec;
    try { spec = JSON.parse(host.getAttribute("data-chart")); }
    catch (error) { host.textContent = "Chart data could not be read."; return; }

    var series = (spec && spec.series) || [];
    if (!series.length) { host.textContent = "No data."; return; }

    var labels = spec.labels || [];
    var kind = spec.type || "line";

    // Shares, not a series over time — no axes, no domain, nothing below applies.
    if (kind === "hex") { drawHex(host, spec, series); return; }
    var W = 600, H = 240;
    var padL = 48, padR = 12, padT = 12, padB = labels.length ? 26 : 12;
    var plotW = W - padL - padR, plotH = H - padT - padB;

    var values = [];
    for (var s = 0; s < series.length; s++) {
      var points = series[s].points || [];
      for (var p = 0; p < points.length; p++) {
        if (typeof points[p] === "number" && isFinite(points[p])) values.push(points[p]);
      }
    }
    if (!values.length) { host.textContent = "No data."; return; }

    /* Zero is always in view. A chart cropped to its own range exaggerates. */
    var bounds = niceScale(Math.min.apply(null, values.concat([0])),
                       Math.max.apply(null, values.concat([0])), 5);
    var span = bounds.max - bounds.min || 1;
    var y = function (value) { return padT + plotH - ((value - bounds.min) / span) * plotH; };

    var svg = el("svg", {
      viewBox: "0 0 " + W + " " + H,
      preserveAspectRatio: "none",
      role: "img",
      style: "width:100%;height:auto;display:block;overflow:visible"
    });

    for (var tick = bounds.min; tick <= bounds.max + 1e-9; tick += bounds.step) {
      var ty = y(tick);
      var zero = Math.abs(tick) < 1e-9;
      svg.appendChild(el("line", {
        x1: padL, x2: W - padR, y1: ty, y2: ty,
        stroke: zero ? "var(--line-strong)" : "var(--line)",
        "stroke-width": 1, "shape-rendering": "crispEdges"
      }));
      var label = el("text", {
        x: padL - 8, y: ty + 3.5, "text-anchor": "end",
        fill: "var(--ink-3)", "font-size": 10
      });
      label.textContent = format(tick, spec.format);
      svg.appendChild(label);
    }

    var count = Math.max.apply(null, series.map(function (one) {
      return (one.points || []).length;
    }));

    if (kind === "dot") {
      /* An area chart stippled onto a grid: each column fills from the baseline
         up to its value, and the dots above stay pale so the unfilled space is
         still visibly part of the same field. One series — a second one would
         overwrite the first's dots rather than layering. */
      var COLS = 56, ROWS = 22;
      var first = series[0];
      var colW = plotW / COLS, rowH = plotH / ROWS;
      var lit = dotColumns(first.points || [], bounds.min, bounds.max, COLS, ROWS);
      for (var dc = 0; dc < COLS; dc++) {
        var on = lit[dc];
        for (var dr = 0; dr < ROWS; dr++) {
          svg.appendChild(el("circle", {
            cx: (padL + colW * (dc + 0.5)).toFixed(1),
            cy: (padT + plotH - rowH * (dr + 0.5)).toFixed(1),
            r: 1.7,
            fill: dr < on ? (first.color || "var(--ink-3)") : "var(--line)"
          }));
        }
      }
    } else if (kind === "bar") {
      var slot = plotW / count;
      var barW = Math.max(2, (slot * 0.62) / series.length);
      for (var b = 0; b < series.length; b++) {
        var bars = series[b].points || [];
        for (var i = 0; i < bars.length; i++) {
          if (typeof bars[i] !== "number") continue;
          var cx = padL + slot * (i + 0.5)
                 - (barW * series.length) / 2 + barW * b;
          var top = Math.min(y(bars[i]), y(0));
          svg.appendChild(el("rect", {
            x: cx, y: top, width: barW,
            height: Math.max(1, Math.abs(y(bars[i]) - y(0))),
            fill: series[b].color || "var(--ink-3)", rx: 2
          }));
        }
      }
    } else {
      var step = count > 1 ? plotW / (count - 1) : 0;
      for (var l = 0; l < series.length; l++) {
        var line = series[l].points || [];
        var coords = [];
        for (var n = 0; n < line.length; n++) {
          if (typeof line[n] !== "number") continue;
          coords.push((padL + step * n) + "," + y(line[n]));
        }
        if (!coords.length) continue;
        var colour = series[l].color || "var(--ink-3)";
        if (kind === "area") {
          svg.appendChild(el("polygon", {
            points: padL + "," + y(0) + " " + coords.join(" ") + " "
                    + (padL + step * (line.length - 1)) + "," + y(0),
            fill: colour, "fill-opacity": 0.12
          }));
        }
        svg.appendChild(el("polyline", {
          points: coords.join(" "), fill: "none", stroke: colour,
          "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round"
        }));
      }
    }

    for (var x = 0; x < labels.length; x++) {
      var lx = kind === "bar"
        ? padL + (plotW / count) * (x + 0.5)
        : padL + (count > 1 ? (plotW / (count - 1)) * x : plotW / 2);
      var tick2 = el("text", {
        x: lx, y: H - 8, "text-anchor": "middle",
        fill: "var(--ink-3)", "font-size": 10
      });
      tick2.textContent = labels[x];
      svg.appendChild(tick2);
    }

    host.textContent = "";
    if (series.length > 1) legendInto(host, series);
    host.appendChild(svg);
  }

  function drawAll() {
    var hosts = document.querySelectorAll(".chart[data-chart]");
    for (var i = 0; i < hosts.length; i++) draw(hosts[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", drawAll);
  } else {
    drawAll();
  }
})();
`

const CHART_STYLE = `
  .chart { margin: 12px 0; background: var(--surface); border-radius: 12px;
           box-shadow: 0 0 0 1px var(--line); padding: 12px; }
  .chart-legend { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 10px; }
  .chart-legend span { display: inline-flex; align-items: center; gap: 6px;
                       font-size: 11.5px; font-weight: 500; color: var(--ink-2); }
  .chart-legend i { width: 6px; height: 6px; border-radius: 50%; flex: none; }
`

/**
 * Build the full document a frame will render.
 *
 * `body` is the stored artifact, inserted verbatim. It is never escaped or
 * sanitised, because sanitising is the wrong control here — the frame's opaque
 * origin and the policy above already make the markup harmless, and a sanitiser
 * would quietly break legitimate documents while providing no guarantee the
 * sandbox does not already provide.
 */
export function buildDocument(body: string, theme: DocumentTheme = 'light'): string {
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${POLICY}">
<base target="_blank">
<style>
:root { ${theme === 'dark' ? DARK : LIGHT} ${CATEGORICAL} }
${BASE}
${CHART_STYLE}
</style>
</head>
<body>
${body}
<script>${CHART_RUNTIME}</script>
</body>
</html>`
}
