/** Sanitize and roll up streamed model text into short status-card narration lines. */

const MAX_LINES = 3;
const MAX_LINE_CHARS = 100;
const MIN_LINE_CHARS = 10;
const FLUSH_BUFFER_CHARS = 88;

const GENERIC_ACTIVITY = /^(running tool|finding capabilities|working|calling tool|discovering skills)/i;

export class NarrationBuffer {
  private buffer = '';
  /** Completed lines — rendered with ✓ on the status card. */
  private done: string[] = [];
  /** In-progress line — rendered with ● on the status card. */
  private current: string | undefined;
  private frozen = false;

  freeze(): void {
    this.frozen = true;
    this.buffer = '';
    if (this.current) {
      this.commitCurrentToDone();
    }
  }

  unfreeze(): void {
    this.frozen = false;
  }

  append(delta: string): boolean {
    if (this.frozen || !delta) return false;
    const before = this.snapshotKey();
    this.buffer += delta;
    this.commitSentences();
    if (this.buffer.length > FLUSH_BUFFER_CHARS) {
      this.setCurrent(trimLine(this.buffer));
      this.buffer = '';
    }
    return this.snapshotKey() !== before;
  }

  flush(): boolean {
    if (!this.buffer.trim()) return false;
    const before = this.snapshotKey();
    this.setCurrent(trimLine(this.buffer));
    this.buffer = '';
    return this.snapshotKey() !== before;
  }

  /** Explicit progress line (tool onProgress, supervisor verbs). */
  pushActivityLine(message: string): boolean {
    if (this.frozen) return false;
    const line = trimLine(message);
    if (line.length < MIN_LINE_CHARS) return false;
    const before = this.snapshotKey();
    this.buffer = '';

    if (this.current === line) return false;

    if (
      this.current
      && isGenericActivity(this.current)
      && !isGenericActivity(line)
    ) {
      this.current = line;
      return this.snapshotKey() !== before;
    }

    if (this.current) this.commitCurrentToDone();
    this.current = line;
    return this.snapshotKey() !== before;
  }

  committedLines(): readonly string[] {
    return this.done;
  }

  active(): string | undefined {
    if (this.current) return this.current;
    const t = this.buffer.trim();
    return t.length >= MIN_LINE_CHARS ? trimLine(t) : undefined;
  }

  /** Move the in-progress line to done (✓) when its tool finishes. */
  completeCurrent(): boolean {
    if (!this.current) return false;
    const before = this.snapshotKey();
    this.commitCurrentToDone();
    return this.snapshotKey() !== before;
  }

  private commitSentences(): void {
    for (;;) {
      const m = this.buffer.match(/^([\s\S]*?[.!?…])\s+(.*)$/);
      if (!m || m[1]!.trim().length < MIN_LINE_CHARS) break;
      this.setCurrent(trimLine(m[1]!));
      this.buffer = m[2] ?? '';
    }
  }

  private setCurrent(line: string): void {
    if (line.length < MIN_LINE_CHARS) return;
    if (this.current === line) return;
    if (this.current) this.commitCurrentToDone();
    this.current = line;
  }

  /**
   * A generic verb ("Running tool…") describes an intention, not an outcome —
   * committing it produced work-log rows like "✓ Running tool…". Those stay as
   * the live line only; the settled rows come from real result summaries.
   */
  private commitCurrentToDone(): void {
    if (!this.current) return;
    const line = this.current;
    this.current = undefined;
    if (isGenericActivity(line)) return;
    const settled = line.replace(/…+$/u, '').trim();
    if (!settled || this.done[this.done.length - 1] === settled) return;
    this.done.push(settled);
    while (this.done.length > MAX_LINES) this.done.shift();
  }

  private snapshotKey(): string {
    return `${this.done.join('|')}::${this.current ?? ''}::${this.buffer}`;
  }
}

function isGenericActivity(line: string): boolean {
  return GENERIC_ACTIVITY.test(line.replace(/…+$/u, '').trim());
}

function trimLine(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .trim()
    .slice(0, MAX_LINE_CHARS);
}
