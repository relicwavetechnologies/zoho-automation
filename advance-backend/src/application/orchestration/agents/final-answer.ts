/**
 * Separates the answer a user should read from the narration that produced it.
 *
 * A tool-calling model talks as it works: "let me check that", "that failed,
 * trying another way". The SDK streams all of it as text, one step at a time,
 * so concatenating every delta hands the user a transcript of the model's
 * deliberation with the real answer buried at the end. Desktop hid this by
 * rendering steps separately; Lark delivers one message, so it showed.
 *
 * The rule is positional, not semantic: whatever the model says *after its last
 * tool call* is the answer, and everything before it was working. No phrasing is
 * inspected, so nothing depends on how a given model narrates.
 */
export class FinalAnswerAccumulator {
  private answer = '';
  private transcript = '';

  appendText(text: string): void {
    this.answer += text;
    this.transcript += text;
  }

  /** Anything said before a tool call was working, not answering. */
  onToolCall(): void {
    this.answer = '';
  }

  /**
   * The reply to deliver.
   *
   * Falls back to the full transcript when the run ended on a tool call and
   * never got to speak — a step budget exhausted mid-task, say. That case is no
   * worse than the old behaviour, and staying silent when the model did produce
   * words would be.
   */
  get text(): string {
    return this.answer.trim() ? this.answer.trim() : this.transcript.trim();
  }

  /** Everything the model said, for logs and length accounting. */
  get fullTranscript(): string {
    return this.transcript;
  }
}
