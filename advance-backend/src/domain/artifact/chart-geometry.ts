/**
 * Where a chart's marks go. Numbers in, coordinates out.
 *
 * Two very different things draw Divo's charts: React components on the
 * dashboard, and a script injected as source text into a sandboxed document
 * frame. They cannot share an import — the frame has no module system and no
 * access to this bundle — so the honest options were to write the maths twice
 * and test that the copies agree, or to make one of them the source and hand
 * the other its text.
 *
 * This is the source. `document.ts` serialises these functions with
 * `Function.prototype.toString()` and pastes them into the frame, so a fix to a
 * scale lands in the dashboard and in every document at once, and the two can
 * never disagree about where a point belongs.
 *
 * **That is why every function here is self-contained.** No imports, no
 * closures, no module-level constants, no TypeScript that survives to runtime.
 * A reference to anything outside a function body is undefined once it is
 * serialised — and it will look fine here while silently failing inside the
 * frame. `chart-geometry.test.ts` runs the serialised text to catch exactly
 * that.
 */

/** A number a person would have chosen for an axis step. */
export function niceNum(range: number, round: boolean): number {
  if (!(range > 0)) return 1
  const exponent = Math.floor(Math.log(range) / Math.LN10)
  const fraction = range / Math.pow(10, exponent)
  let nice: number
  if (round) nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10
  else nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return nice * Math.pow(10, exponent)
}

/**
 * Axis bounds that round outward, so gridlines carry round numbers.
 *
 * Callers are expected to have already put zero inside `[min, max]`. That is
 * not enforced here because it is a question about the data's meaning rather
 * than about arithmetic — but a chart cropped to its own range turns a 2%
 * wobble into a cliff, so the callers in this repo all do it.
 */
export function niceScale(
  min: number,
  max: number,
  ticks: number,
): { min: number; max: number; step: number } {
  let high = max
  if (min === high) high = min + 1
  const step = niceNum(niceNum(high - min, false) / (ticks - 1), true)
  return {
    min: Math.floor(min / step) * step,
    max: Math.ceil(high / step) * step,
    step: step,
  }
}

/**
 * Centres of a pointy-top hexagonal grid, nearest the middle first.
 *
 * Pointy-top is the orientation that tiles into a blob rather than into visible
 * vertical seams. The distance is measured on an ellipse rather than a circle,
 * so filling in this order grows a cluster that is wider than it is tall — the
 * shape a reader expects, rather than a perfect disc.
 */
export function hexCells(
  cols: number,
  rows: number,
  radius: number,
): { x: number; y: number; width: number; height: number }[] {
  const stepX = Math.sqrt(3) * radius
  const stepY = 1.5 * radius
  const width = cols * stepX + stepX
  const height = rows * stepY + radius * 2
  const cells: { x: number; y: number; width: number; height: number; d: number }[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * stepX + (row % 2 ? stepX : stepX / 2) + stepX / 2
      const y = row * stepY + radius
      const dx = (x - width / 2) / (width / 2)
      const dy = (y - height / 2) / (height / 2)
      cells.push({ x: x, y: y, width: width, height: height, d: Math.sqrt(dx * dx + dy * dy * 0.55) })
    }
  }
  cells.sort(function (a, b) { return a.d - b.d })
  return cells.map(function (c) { return { x: c.x, y: c.y, width: c.width, height: c.height } })
}

/**
 * Which series owns each cell of a hex cluster, by index; -1 for unfilled.
 *
 * Assigned smallest share first so the smallest category sits at the core and
 * the largest forms the outer band. Filled in declaration order the regions
 * interleave and the cluster stops meaning anything, which is why the ordering
 * is part of this function rather than left to the caller.
 *
 * The largest share absorbs the rounding remainder, so the painted cells always
 * total exactly the filled count instead of leaving a stray gap.
 */
export function shareAssignment(
  values: number[],
  cellCount: number,
  density: number,
): number[] {
  const total = values.reduce(function (sum, one) { return sum + Math.max(0, one) }, 0)
  const assignment = new Array(cellCount).fill(-1)
  if (!(total > 0)) return assignment

  const filled = Math.round(cellCount * density)
  const order = values
    .map(function (value, index) { return { index: index, value: Math.max(0, value) } })
    .sort(function (a, b) { return a.value - b.value })

  let at = 0
  for (let o = 0; o < order.length; o++) {
    /* Held in a local rather than indexed twice. The backend compiles with
       `noUncheckedIndexedAccess` — the admin build this was ported from did
       not — and a bounds check the loop already guarantees is cheaper to state
       than to assert away. `!` would also be the wrong tool here: this function
       is serialised with `toString()` and evaluated inside the document frame,
       so anything that survives to the frame has to be plain JavaScript. */
    const entry = order[o]
    if (!entry) continue
    const take = o === order.length - 1
      ? filled - at
      : Math.round((entry.value / total) * filled)
    for (let k = 0; k < take && at < filled; k++) assignment[at++] = entry.index
  }
  return assignment
}

/**
 * How many dots are lit in each column of a dot-field chart.
 *
 * The series is resampled to the column count, so a chart with twelve readings
 * and fifty-six columns interpolates rather than repeating each reading four
 * and a bit times and stepping visibly.
 */
export function dotColumns(
  points: number[],
  min: number,
  max: number,
  cols: number,
  rows: number,
): number[] {
  const span = max - min || 1
  const lit: number[] = []
  for (let col = 0; col < cols; col++) {
    const t = points.length > 1 ? (col / (cols - 1)) * (points.length - 1) : 0
    const low = Math.floor(t)
    const high = Math.min(points.length - 1, low + 1)
    /* Same reason as `shareAssignment` above. `low` and `high` are both clamped
       into the array, so the fallbacks never fire; they are here to say that in
       a way the compiler can read. */
    const lowValue = points[low] ?? 0
    const highValue = points[high] ?? lowValue
    const value = lowValue + (highValue - lowValue) * (t - low)
    lit.push(Math.round(((value - min) / span) * rows))
  }
  return lit
}

/** Every function above, as text a frame can evaluate. */
export const CHART_GEOMETRY_SOURCE = [
  niceNum, niceScale, hexCells, shareAssignment, dotColumns,
].map(function (fn) { return fn.toString() }).join('\n')
