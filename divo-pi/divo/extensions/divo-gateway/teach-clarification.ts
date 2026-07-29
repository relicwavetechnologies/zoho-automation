import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readDivoRunCorrelation, type DivoRunCorrelationV1 } from "./run-correlation.ts";

export const DIVO_TEACH_CLARIFICATION_PROTOCOL_TITLE = "divo_teach_clarification_v1";
export const MAX_TEACH_CLARIFICATION_QUESTIONS = 3;
export const MAX_TEACH_CLARIFICATION_OPTIONS = 5;

type JsonRecord = Record<string, unknown>;
type SelectionMode = "single" | "multiple";

export interface TeachClarificationOptionV1 {
	id: string;
	label: string;
	description?: string;
}

export interface TeachClarificationQuestionV1 {
	id: string;
	question: string;
	whyItMatters?: string;
	selection: SelectionMode;
	options: TeachClarificationOptionV1[];
	allowCustom: boolean;
}

export interface TeachClarificationRequestV1 {
	version: 1;
	reason: string;
	questions: TeachClarificationQuestionV1[];
	runCorrelation: DivoRunCorrelationV1;
}

type TeachClarificationPayloadV1 = Omit<TeachClarificationRequestV1, "runCorrelation">;

export interface TeachClarificationAnswerV1 {
	questionId: string;
	selectedOptionIds: string[];
	customText?: string;
}

export interface TeachClarificationResponseV1 {
	version: 1;
	decision: "answer" | "cancel";
	answers: TeachClarificationAnswerV1[];
}

const OPTION_SCHEMA = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 120 }),
	label: Type.String({ minLength: 1, maxLength: 240 }),
	description: Type.Optional(Type.String({ maxLength: 500 })),
});

const TEACH_CLARIFICATION_PARAMS = Type.Object({
	reason: Type.String({
		minLength: 1,
		maxLength: 1_000,
		description: "Concise explanation of the material uncertainty. Do not expose hidden reasoning.",
	}),
	questions: Type.Array(Type.Object({
		id: Type.String({
			minLength: 1,
			maxLength: 120,
			pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
		}),
		question: Type.String({ minLength: 1, maxLength: 500 }),
		whyItMatters: Type.Optional(Type.String({ maxLength: 500 })),
		selection: StringEnum(["single", "multiple"] as const),
		options: Type.Array(OPTION_SCHEMA, {
			minItems: 2,
			maxItems: MAX_TEACH_CLARIFICATION_OPTIONS,
		}),
		allowCustom: Type.Optional(Type.Boolean({
			description: "Allow the manager to provide a short answer outside the listed choices. Defaults to true.",
		})),
	}), {
		minItems: 1,
		maxItems: MAX_TEACH_CLARIFICATION_QUESTIONS,
	}),
});

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as JsonRecord
		: undefined;
}

function boundedString(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${field} must be a non-empty string`);
	}
	const result = value.trim();
	if (result.length > maxLength) throw new Error(`${field} is too long`);
	return result;
}

export function validateTeachClarificationRequest(value: unknown): TeachClarificationPayloadV1 {
	const record = asRecord(value);
	if (!record) throw new Error("Teach clarification must be an object");
	const reason = boundedString(record.reason, "reason", 1_000);
	if (!Array.isArray(record.questions) || record.questions.length < 1 || record.questions.length > MAX_TEACH_CLARIFICATION_QUESTIONS) {
		throw new Error("Teach clarification must contain one to three questions");
	}
	const questionIds = new Set<string>();
	const questions = record.questions.map((rawQuestion, questionIndex) => {
		const question = asRecord(rawQuestion);
		if (!question) throw new Error(`questions[${questionIndex}] must be an object`);
		const id = boundedString(question.id, `questions[${questionIndex}].id`, 120);
		if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(id)) {
			throw new Error(`questions[${questionIndex}].id must be a stable lowercase key`);
		}
		if (questionIds.has(id)) throw new Error("Teach clarification question ids must be unique");
		questionIds.add(id);
		const selection = question.selection;
		if (selection !== "single" && selection !== "multiple") {
			throw new Error(`questions[${questionIndex}].selection is invalid`);
		}
		if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > MAX_TEACH_CLARIFICATION_OPTIONS) {
			throw new Error(`questions[${questionIndex}] must contain two to five options`);
		}
		const optionIds = new Set<string>();
		const options = question.options.map((rawOption, optionIndex) => {
			const option = asRecord(rawOption);
			if (!option) throw new Error(`questions[${questionIndex}].options[${optionIndex}] must be an object`);
			const optionId = boundedString(option.id, `questions[${questionIndex}].options[${optionIndex}].id`, 120);
			if (optionIds.has(optionId)) throw new Error(`questions[${questionIndex}] option ids must be unique`);
			optionIds.add(optionId);
			const description = option.description === undefined
				? undefined
				: boundedString(option.description, `questions[${questionIndex}].options[${optionIndex}].description`, 500);
			return {
				id: optionId,
				label: boundedString(option.label, `questions[${questionIndex}].options[${optionIndex}].label`, 240),
				...(description ? { description } : {}),
			};
		});
		const whyItMatters = question.whyItMatters === undefined
			? undefined
			: boundedString(question.whyItMatters, `questions[${questionIndex}].whyItMatters`, 500);
		return {
			id,
			question: boundedString(question.question, `questions[${questionIndex}].question`, 500),
			...(whyItMatters ? { whyItMatters } : {}),
			selection,
			options,
			allowCustom: question.allowCustom !== false,
		};
	});
	return { version: 1, reason, questions };
}

export function parseTeachClarificationResponse(
	value: unknown,
	request: TeachClarificationRequestV1,
): TeachClarificationResponseV1 {
	const response = asRecord(value);
	if (!response || response.version !== 1) throw new Error("unsupported Teach clarification response");
	if (response.decision === "cancel") return { version: 1, decision: "cancel", answers: [] };
	if (response.decision !== "answer" || !Array.isArray(response.answers)) {
		throw new Error("Teach clarification response is invalid");
	}
	const answersByQuestion = new Map<string, JsonRecord>();
	for (const rawAnswer of response.answers) {
		const answer = asRecord(rawAnswer);
		if (!answer) throw new Error("Teach clarification answer must be an object");
		const questionId = boundedString(answer.questionId, "answer.questionId", 120);
		if (answersByQuestion.has(questionId)) throw new Error("Teach clarification answers must be unique");
		answersByQuestion.set(questionId, answer);
	}
	const answers = request.questions.map((question) => {
		const answer = answersByQuestion.get(question.id);
		if (!answer) throw new Error(`Teach clarification answer is missing for ${question.id}`);
		if (!Array.isArray(answer.selectedOptionIds)) throw new Error("selectedOptionIds must be an array");
		const availableOptionIds = new Set(question.options.map((option) => option.id));
		const selectedOptionIds = answer.selectedOptionIds.map((id) => boundedString(id, "selectedOptionIds item", 120));
		if (new Set(selectedOptionIds).size !== selectedOptionIds.length || selectedOptionIds.some((id) => !availableOptionIds.has(id))) {
			throw new Error(`Teach clarification answer contains an invalid option for ${question.id}`);
		}
		if (question.selection === "single" && selectedOptionIds.length > 1) {
			throw new Error(`${question.id} accepts only one option`);
		}
		const customText = answer.customText === undefined || answer.customText === ""
			? undefined
			: boundedString(answer.customText, "answer.customText", 1_000);
		if (customText && !question.allowCustom) throw new Error(`${question.id} does not allow a custom answer`);
		if (selectedOptionIds.length === 0 && !customText) throw new Error(`Teach clarification answer is empty for ${question.id}`);
		return {
			questionId: question.id,
			selectedOptionIds,
			...(customText ? { customText } : {}),
		};
	});
	return { version: 1, decision: "answer", answers };
}

async function presentTeachClarification(
	ctx: Pick<ExtensionContext, "ui">,
	request: TeachClarificationPayloadV1,
): Promise<TeachClarificationResponseV1> {
	const correlatedRequest: TeachClarificationRequestV1 = {
		...request,
		runCorrelation: await readDivoRunCorrelation(),
	};
	if (correlatedRequest.runCorrelation.profile !== "teach") {
		throw new Error("Teach clarification is available only during a Teach session");
	}
	const raw = await ctx.ui.editor(
		DIVO_TEACH_CLARIFICATION_PROTOCOL_TITLE,
		JSON.stringify(correlatedRequest),
	);
	if (raw === undefined) return { version: 1, decision: "cancel", answers: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("desktop returned malformed Teach clarification JSON");
	}
	return parseTeachClarificationResponse(parsed, correlatedRequest);
}

export async function executeTeachClarification(
	params: unknown,
	ctx: Pick<ExtensionContext, "ui">,
) {
	try {
		const request = validateTeachClarificationRequest(params);
		const response = await presentTeachClarification(ctx, request);
		if (response.decision === "cancel") {
			return {
				content: [{ type: "text" as const, text: "The manager cancelled clarification. Do not write learning yet; ask how they want to continue." }],
				details: response,
			};
		}
		const answerText = response.answers.map((answer) => {
			const question = request.questions.find((candidate) => candidate.id === answer.questionId)!;
			const selected = answer.selectedOptionIds.map((id) => question.options.find((option) => option.id === id)?.label).filter(Boolean);
			return `${question.question}\nAnswer: ${[...selected, answer.customText].filter(Boolean).join("; ")}`;
		}).join("\n\n");
		return {
			content: [{ type: "text" as const, text: `Manager clarification received:\n\n${answerText}` }],
			details: response,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: `Teach clarification could not complete safely: ${message}` }],
			details: { decision: "cancel", error: message },
		};
	}
}

export function registerTeachClarificationTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "divo_teach_clarify",
		label: "Clarify teaching",
		description: "Pause a Divo Teach run and ask the manager one to three material multiple-choice questions in an inline composer card. The answers return to this same agent run.",
		promptSnippet: "During Teach, use divo_teach_clarify when missing context could materially change a persona rule, skill, workflow, trigger, monitoring scope, autonomy boundary, or failure behavior.",
		promptGuidelines: [
			"Use only during Divo Teach after reading teach.context.get.",
			"Ask no more than three related material questions. Never ask for facts already clear from evidence or current context.",
			"Offer two to five concrete options and allow a custom answer unless the choices are genuinely exhaustive.",
			"If the manager cancels, do not call teach.learning.apply.",
		],
		parameters: TEACH_CLARIFICATION_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeTeachClarification(params, ctx);
		},
	});
}
