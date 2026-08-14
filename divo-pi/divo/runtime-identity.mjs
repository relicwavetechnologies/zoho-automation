/**
 * Who a run belongs to, and what it is allowed to call itself.
 *
 * Every name a run is addressed by — profile, thread, session scope, model — is
 * derived or validated here, and nothing in this module talks to Docker or to
 * the backend. That is deliberate: the rule that one member's thread can never
 * resolve to another member's workspace is the runtime's central isolation
 * guarantee, and it should be readable end to end without a container running.
 */
import { createHash } from "node:crypto";
import {
	RUNTIME_MODEL_IDS,
	isRuntimeModel,
	providerForModel,
} from "./runtime-models.mjs";

export function validateProfileName(value) {
	const profile = value?.trim().toLowerCase();
	if (!profile || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile)) {
		throw new Error("Profile must use 1-32 lowercase letters, numbers, dash, or underscore");
	}
	return profile;
}

export function validateThread(value) {
	if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) {
		throw new Error("Thread must contain only letters, numbers, dot, underscore, or dash");
	}
	return value;
}

export const SESSION_SCOPES = ["thread", "run"];
export const SESSION_LIFECYCLE_OPERATIONS = ["prepare", "reset", "delete"];

export function validateSessionLifecycleOperation(value) {
	if (!SESSION_LIFECYCLE_OPERATIONS.includes(value)) {
		throw new Error(
			`operation must be one of: ${SESSION_LIFECYCLE_OPERATIONS.join(", ")}`,
		);
	}
	return value;
}

/**
 * Which session a run reopens.
 *
 * `thread` is the durable session on the user's volume, and stays the default:
 * a DM is one person's conversation, and resuming it is the continuity.
 *
 * `run` gives the run a session that is deleted when it ends. The backend asks
 * for it when a thread is shared by several people, because each of them runs
 * in their own container: that conversation is held centrally and sent into
 * every run, so keeping a copy per user would append the same transcript to one
 * volume on every turn and replay all of it on the next.
 */
export function validateSessionScope(value) {
	if (value === undefined || value === null) return "thread";
	if (!SESSION_SCOPES.includes(value)) {
		throw new Error(`sessionScope must be one of: ${SESSION_SCOPES.join(", ")}`);
	}
	return value;
}

/**
 * The model a run is launched on.
 *
 * The backend picks one from the member's grant and names it here; naming none
 * leaves the manifest's default, which is what every run used before the grant
 * could reach this far.
 */
export function validateRuntimeModel(value) {
	if (value === undefined || value === null || value === "") return undefined;
	if (!isRuntimeModel(value)) {
		throw new Error(`model must be one of: ${RUNTIME_MODEL_IDS.join(", ")}`);
	}
	return { model: value, provider: providerForModel(value) };
}

export function runtimeIdentityNames(
	companyId,
	userId,
	runtimeThreadId,
	{ contextAudience = "private", runId } = {},
) {
	if (!companyId || !userId || !runtimeThreadId) {
		throw new Error("Runtime identity is incomplete");
	}
	if (contextAudience !== "private" && contextAudience !== "shared") {
		throw new Error("Runtime context audience is invalid");
	}
	if (contextAudience === "shared" && !runId) {
		throw new Error("A shared runtime requires a run identity");
	}
	const digest = (value) => createHash("sha256").update(value).digest("hex");
	const privateProfile = `cloud-${digest(`${companyId}:${userId}`).slice(0, 20)}`;
	const sharedProfile = runId
		? `shared-${digest(`${companyId}:${userId}:${runId}`).slice(0, 20)}`
		: undefined;
	return {
		profile: contextAudience === "shared" ? sharedProfile : privateProfile,
		thread: `lark-${digest(runtimeThreadId).slice(0, 24)}`,
		runtimeThreadId,
		contextAudience,
		ephemeral: contextAudience === "shared",
	};
}

export function trustedRuntimeSession(session) {
	return {
		userId: session.userId,
		companyId: session.companyId,
		departments: Array.isArray(session.departments)
			? session.departments
				.filter((department) =>
					typeof department?.id === "string" && department.id.trim(),
				)
				.map((department) => ({
					id: department.id,
					...(typeof department.name === "string" && department.name
						? { name: department.name }
						: {}),
				}))
			: [],
	};
}

export function assertPinnedProfile(metadata, session) {
	if (
		metadata.userId !== session.userId ||
		metadata.companyId !== session.companyId
	) {
		throw new Error(
			`Current Lark identity does not match pinned profile "${metadata.profile}"`,
		);
	}
}

export function assertExpectedLogin(session, exchangeSession, expectedEmail) {
	if (!expectedEmail) return;
	const actualEmail = (
		session.email ??
		session.user?.email ??
		exchangeSession?.email ??
		""
	)
		.trim()
		.toLowerCase();
	if (actualEmail !== expectedEmail.trim().toLowerCase()) {
		throw new Error(
			`Authenticated as "${actualEmail || "unknown email"}", expected "${expectedEmail}"`,
		);
	}
}
