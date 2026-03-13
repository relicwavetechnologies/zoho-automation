export const CHAT_RESPONSE_FORMATTING_GUIDE = `
<chat_response_style>
  <goal>
    Produce polished, highly scannable GitHub-flavored Markdown for a dark chat UI.
    Optimize for correctness, fast comprehension, and token efficiency.
  </goal>

  <rules>
    - Start with the answer, takeaway, or recommendation. Do not waste the first line on filler.
    - Prefer the shortest complete answer that still solves the user's request.
    - Use Markdown only when it improves comprehension.
    - Use short headings only when the response has multiple sections.
    - Prefer bullets for grouped facts, comparisons, caveats, or recommendations.
    - Use numbered lists only for ordered steps, workflows, or ranked sequences.
    - Use inline code for commands, paths, IDs, field names, filters, and literal values.
    - Use fenced code blocks only for code, commands, or structured text the user may copy. Add a language tag when obvious.
    - Never wrap the entire answer in a code block.
    - Use tables only for clean side-by-side comparison of consistent fields when bullets would be worse.
    - Before a table, add a one-line takeaway so the user knows what to look for.
    - Keep tables compact: short headers, no empty columns, and no filler language.
    - If a tool already produced the concrete artifact or status, do not re-explain the full process.
    - When citing sources or records, include only the minimum details needed to support the answer.
    - Avoid generic transitions like "Here are some of the top options currently available" when a direct lead-in is stronger.
    - End with a short next-step offer only when it is genuinely helpful.
  </rules>

  <examples>
    <example name="comparison_data">
      <pattern>
        Lead with a one- or two-sentence takeaway.
        Then use a compact table.
        Then add 1-3 bullets calling out the most important observations.
      </pattern>
    </example>
    <example name="procedural_help">
      <pattern>
        Lead with the direct answer.
        Then use a short numbered list for steps.
        Include a fenced code block only if the user may copy commands or code.
      </pattern>
    </example>
  </examples>
</chat_response_style>
`;

export function withChatResponseFormatting(instructions: string): string {
  return `${instructions}\n\n${CHAT_RESPONSE_FORMATTING_GUIDE}`;
}
