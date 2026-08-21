/**
 * What the surface this run answers on can carry, and the one place a surface
 * is allowed to turn into words.
 *
 * The rule the whole design rests on: **there is exactly one function here that
 * writes prose.** Nobody writes a Lark prompt and a web prompt. You change a
 * value in the descriptor and the sentence follows. The moment a second
 * generator exists, there are two agents wearing one name.
 */
export interface DivoSurfaceCapabilities {
	key: string;
	audience: "private" | "shared";
	/** Can a generated file be handed back, and how? */
	artifacts: "none" | "link" | "inline";
	/** Can a chart render, or must it become a table? */
	charts: boolean;
	tables: { maxRows: number; maxPerMessage: number };
	maxBlockChars: number;
	maxMessageBytes: number;
	/** How the work log reaches the reader. */
	worklog: "patched-card" | "streamed";
	/** How densely public-web evidence is attached to the claims it supports. */
	citations: "compact" | "claim-level";
	/** How much of a decision the surface can collect at once. */
	decisions: "buttons" | "form";
	/** May Divo offer "this is better on the web"? */
	handoff: boolean;
}

const PRESENTATION_POLICY_OPEN_TAG = "<divo_presentation_policy>";
const PRESENTATION_POLICY_CLOSE_TAG = "</divo_presentation_policy>";

const ARTIFACT_MODES = new Set(["none", "link", "inline"]);
const AUDIENCES = new Set(["private", "shared"]);
const WORKLOG_MODES = new Set(["patched-card", "streamed"]);
const CITATION_MODES = new Set(["compact", "claim-level"]);
const DECISION_MODES = new Set(["buttons", "form"]);

function positiveInt(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Read the descriptor the backend sent, or nothing.
 *
 * Nothing is the correct answer for a malformed record: no block is emitted, and
 * Divo behaves as it did before any of this existed. Guessing a descriptor would
 * mean telling the model something about a surface we could not read.
 */
export function parseSurfaceCapabilities(value: unknown): DivoSurfaceCapabilities | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const data = value as Record<string, unknown>;
	const tables = data.tables as Record<string, unknown> | undefined;

	const key = typeof data.key === "string" ? data.key.trim().slice(0, 40) : "";
	const audience = typeof data.audience === "string" ? data.audience : "";
	const maxRows = positiveInt(tables?.maxRows);
	const maxPerMessage = positiveInt(tables?.maxPerMessage);
	const maxBlockChars = positiveInt(data.maxBlockChars);
	const maxMessageBytes = positiveInt(data.maxMessageBytes);

	if (
		!key
		|| !AUDIENCES.has(audience)
		|| typeof data.artifacts !== "string" || !ARTIFACT_MODES.has(data.artifacts)
		|| typeof data.charts !== "boolean"
		|| typeof data.handoff !== "boolean"
		|| typeof data.worklog !== "string" || !WORKLOG_MODES.has(data.worklog)
		|| typeof data.citations !== "string" || !CITATION_MODES.has(data.citations)
		|| typeof data.decisions !== "string" || !DECISION_MODES.has(data.decisions)
		|| maxRows === null || maxPerMessage === null
		|| maxBlockChars === null || maxMessageBytes === null
	) return null;

	return {
		key,
		audience: audience as DivoSurfaceCapabilities["audience"],
		artifacts: data.artifacts as DivoSurfaceCapabilities["artifacts"],
		charts: data.charts,
		tables: { maxRows, maxPerMessage },
		maxBlockChars,
		maxMessageBytes,
		worklog: data.worklog as DivoSurfaceCapabilities["worklog"],
		citations: data.citations as DivoSurfaceCapabilities["citations"],
		decisions: data.decisions as DivoSurfaceCapabilities["decisions"],
		handoff: data.handoff,
	};
}

/**
 * Turn a descriptor into the only sentences in the system that a surface writes.
 *
 * Every line is generated from a field. Nothing is conditional on the channel's
 * name — `key` is reported so a trace can say which surface a run answered on,
 * never so the model can branch on it. If you find yourself wanting
 * `if (caps.key === 'lark')` here, the thing you want is a new field.
 */
export function presentationPolicy(caps: DivoSurfaceCapabilities): string {
	const lines: string[] = [
		`You are answering on the "${caps.key}" surface. This changes how you present`,
		"work. It never changes what you are willing to do, what you are allowed to",
		"do, or how carefully you do it.",
		`This answer is for a ${caps.audience} audience.`,
		"",
	];

	if (caps.artifacts === "none") {
		lines.push(
			"- This surface cannot hand a file to the reader. Put the complete result in",
			"  the reply itself. Do not write a file as the deliverable and report its",
			"  path — the reader has no way to open it.",
		);
	} else if (caps.artifacts === "link") {
		lines.push(
			"- A file you create can be handed back as a link. Still summarize the result",
			"  in the reply; the link is for the detail, not a substitute for the answer.",
		);
	} else {
		lines.push(
			"- A file you create is shown to the reader beside this conversation. Use one",
			"  when the result is a document, a dataset, or something they will keep. Say",
			"  in the reply what it contains; do not paste the whole of it back as well.",
		);
	}

	lines.push(
		caps.charts
			? "- A chart renders here. Use one when a shape is the point; keep the numbers in the text as well."
			: "- No chart renders here. Anything you would have charted becomes a short table or a sentence.",
		`- A table can carry ${caps.tables.maxRows} rows, and at most ${caps.tables.maxPerMessage} tables per message.`
		+ " Past that, say what the rest shows rather than truncating it silently.",
		`- Keep any single block under ${caps.maxBlockChars} characters and the whole reply`
		+ ` under roughly ${Math.floor(caps.maxMessageBytes / 1_000)}KB. These are hard limits of the surface,`
		+ " not style advice: past them the reader sees less than you sent.",
	);

	if (caps.worklog === "patched-card") {
		lines.push(
			"- Your progress is shown as a single status message that is rewritten as you",
			"  work. Narrate steps as you take them; do not restate the whole run at the end.",
		);
	} else {
		lines.push(
			"- Your progress is streamed live as you work, step by step. Narrate steps as",
			"  you take them; do not restate the whole run at the end.",
		);
	}

	if (caps.citations === "claim-level") {
		lines.push(
			"- When an answer uses public web research, put a relevant Markdown source",
			"  link beside every externally verifiable factual paragraph and list item.",
			"  Cite every factual table row; when cells use different sources, cite those",
			"  cells separately. A Sources section may supplement these links but cannot",
			"  replace them. Reuse exact URLs returned by search; never invent or rewrite one.",
		);
	} else {
		lines.push(
			"- When an answer uses public web research, cite its material and time-sensitive",
			"  claims, then finish with a short Sources section. Keep citations compact; do",
			"  not repeat the same source on every paragraph, list item, or table row.",
			"  Reuse exact URLs returned by search; never invent or rewrite one.",
		);
	}

	lines.push(
		caps.decisions === "buttons"
			? "- When something needs a decision, the reader gets buttons. Say plainly what you are asking, then stop and wait."
			: "- When something needs a decision, the reader is asked inline. Say plainly what you are asking, then stop and wait.",
	);

	if (caps.handoff) {
		lines.push(
			"- If a result would genuinely be better read on the web — a long document, a",
			"  dataset, anything visual — you may offer to continue there. Offer once, and",
			"  only when it is genuinely better; never as a way to avoid answering here.",
		);
	}

	return [PRESENTATION_POLICY_OPEN_TAG, lines.join("\n"), PRESENTATION_POLICY_CLOSE_TAG].join("\n");
}
