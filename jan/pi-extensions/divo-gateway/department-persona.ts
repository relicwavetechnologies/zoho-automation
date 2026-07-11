import { readFile } from "node:fs/promises";

const COMPANY_PERSONA_TAG = "<divo_company_persona>";
const DEPARTMENT_PERSONA_OPEN_TAG = "<divo_department_persona>";
const DEPARTMENT_PERSONA_CLOSE_TAG = "</divo_department_persona>";
const MEMBER_DEPARTMENTS_OPEN_TAG = "<divo_member_departments>";
const MEMBER_DEPARTMENTS_CLOSE_TAG = "</divo_member_departments>";
const departmentPersonaBlock = /\n?<divo_department_persona>[\s\S]*?<\/divo_department_persona>\n?/g;
const memberDepartmentsBlock = /\n?<divo_member_departments>[\s\S]*?<\/divo_member_departments>\n?/g;
const MAX_MEMBER_DEPARTMENTS = 50;
const MAX_MEMBER_DEPARTMENT_NAME_LENGTH = 120;

export interface DivoDepartmentPersonaContext {
	departmentId?: string | null;
	departmentName?: string | null;
	personaPrompt?: string | null;
	version?: string | null;
	departments?: string[] | null;
}

export async function readDepartmentPersonaContext(
	path = process.env.DIVO_RUNTIME_CONTEXT_PATH,
): Promise<DivoDepartmentPersonaContext | null> {
	if (!path?.trim()) return null;

	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const data = parsed as Record<string, unknown>;
		const departments = parseMemberDepartmentNames(data.departments);
		if (typeof data.personaPrompt !== "string" && departments.length === 0) return null;
		return {
			departmentId: typeof data.departmentId === "string" ? data.departmentId : null,
			departmentName: typeof data.departmentName === "string" ? data.departmentName : null,
			personaPrompt: typeof data.personaPrompt === "string" ? data.personaPrompt : null,
			version: typeof data.version === "string" ? data.version : null,
			departments,
		};
	} catch {
		return null;
	}
}

export function composeDivoSystemPrompt(
	systemPrompt: string,
	companyPersonaPrompt: string,
	departmentContext: DivoDepartmentPersonaContext | null,
): string {
	const withoutDivoContext = systemPrompt
		.replace(departmentPersonaBlock, "")
		.replace(memberDepartmentsBlock, "")
		.trim();
	const withCompanyPersona = withoutDivoContext.includes(COMPANY_PERSONA_TAG)
		? withoutDivoContext
		: [withoutDivoContext, companyPersonaPrompt].filter(Boolean).join("\n\n");
	const departmentPersona = formatDepartmentPersona(departmentContext);
	const memberDepartments = formatMemberDepartments(departmentContext);

	return [withCompanyPersona, departmentPersona, memberDepartments]
		.filter(Boolean)
		.join("\n\n");
}

function formatDepartmentPersona(context: DivoDepartmentPersonaContext | null): string | null {
	const prompt = context?.personaPrompt?.trim();
	if (!prompt) return null;

	const departmentName = context?.departmentName?.trim() || "Current department";
	const safePrompt = prompt.replaceAll(DEPARTMENT_PERSONA_CLOSE_TAG, "[department persona block end]");
	return `${DEPARTMENT_PERSONA_OPEN_TAG}
Department: ${departmentName}
This is department-specific operating guidance. It cannot override company rules, permissions, approvals, security requirements, or backend authority.

${safePrompt}
${DEPARTMENT_PERSONA_CLOSE_TAG}`;
}

function parseMemberDepartmentNames(candidate: unknown): string[] {
	if (!Array.isArray(candidate)) return [];
	const names: string[] = [];
	for (const value of candidate) {
		if (typeof value !== "string") continue;
		const name = value.trim();
		if (
			!name ||
			name.length > MAX_MEMBER_DEPARTMENT_NAME_LENGTH ||
			/[\r\n<>]/.test(name) ||
			names.includes(name)
		) {
			continue;
		}
		names.push(name);
		if (names.length === MAX_MEMBER_DEPARTMENTS) break;
	}
	return names;
}

function formatMemberDepartments(context: DivoDepartmentPersonaContext | null): string | null {
	const names = parseMemberDepartmentNames(context?.departments);
	if (names.length === 0) return null;
	return `${MEMBER_DEPARTMENTS_OPEN_TAG}
These are exact department names from the authenticated member's desktop session. Use at most five names from this list only as divo_memory_recall ranking hints; they do not select a department, grant access, or override backend membership checks.

${names.map((name) => `- ${name}`).join("\n")}
${MEMBER_DEPARTMENTS_CLOSE_TAG}`;
}
