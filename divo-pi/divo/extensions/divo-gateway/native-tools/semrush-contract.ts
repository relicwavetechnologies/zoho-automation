/**
 * Pi-native Semrush contract.
 *
 * This is deliberately owned by the Divo Pi extension instead of being
 * reconstructed from a bootstrap response. It is the model-facing contract:
 * Pi exposes it from process start and validates calls before they leave the
 * container. The backend independently validates the same business input and
 * remains authoritative for identity, RBAC, provider credentials, quotas,
 * approval policy, execution, and audit.
 *
 * Keep this module dependency-free. The backend parity suite imports it during
 * CI, which makes contract drift fail visibly without coupling either runtime
 * to the other's package installation.
 */

export const DIVO_SEMRUSH_TOOL_ID = "semrush";
export const DIVO_SEMRUSH_TOOL_NAME = "divo_semrush";

export const DIVO_SEMRUSH_OPERATIONS = [
	"domain_overview",
	"backlinks_comparison",
	"keyword_position_trend",
] as const;

export type DivoSemrushArgs =
	| {
		operation: "domain_overview";
		domain: string;
		database?: string;
	}
	| {
		operation: "backlinks_comparison";
		targets: string[];
	}
	| {
		operation: "keyword_position_trend";
		domain: string;
		keyword: string;
		date: string;
		database?: string;
		dateType?: "daily" | "monthly";
	};

const BARE_DOMAIN_SCHEMA = {
	type: "string",
	minLength: 3,
	maxLength: 253,
	pattern: "^(?=.{3,253}$)(?=.*\\.)[^/?#@:\\s]+$",
	description: "Bare domain only, such as example.com. Never include a protocol, path, credentials, port, query, or whitespace.",
} as const;
const DATABASE_SCHEMA = {
	type: "string",
	pattern: "^[a-z]{2}$",
	description: "Optional two-letter lowercase Semrush country database code, such as in, us, or ru.",
} as const;

/**
 * The explicit root `type` is intentional. Tool providers require an object
 * root even when JSON Schema already proves that through object-only `anyOf`
 * branches.
 */
export const DIVO_SEMRUSH_PARAMS = {
	type: "object",
	anyOf: [
		{
			type: "object",
			properties: {
				operation: {
					type: "string",
					const: "domain_overview",
					description: "Return domain rank, organic and paid keywords, traffic, and cost by Semrush country database.",
				},
				domain: BARE_DOMAIN_SCHEMA,
				database: DATABASE_SCHEMA,
			},
			required: ["operation", "domain"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				operation: {
					type: "string",
					const: "backlinks_comparison",
					description: "Compare authority, backlinks, and referring domains for every requested target in one provider request.",
				},
				targets: {
					type: "array",
					items: BARE_DOMAIN_SCHEMA,
					minItems: 1,
					maxItems: 10,
					uniqueItems: true,
					description: "One to ten unique bare domains. Put every domain in this single call; do not fan out one call per target.",
				},
			},
			required: ["operation", "targets"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				operation: {
					type: "string",
					const: "keyword_position_trend",
					description: "Return a dated series of positions for one keyword around the requested date.",
				},
				domain: BARE_DOMAIN_SCHEMA,
				keyword: {
					type: "string",
					minLength: 1,
					maxLength: 120,
					description: "The exact keyword whose position history should be retrieved.",
				},
				date: {
					type: "string",
					pattern: "^\\d{8}$",
					description: "Semrush date in YYYYMMDD form.",
				},
				database: DATABASE_SCHEMA,
				dateType: {
					type: "string",
					enum: ["daily", "monthly"],
					description: "Optional granularity for the returned position series.",
				},
			},
			required: ["operation", "domain", "keyword", "date"],
			additionalProperties: false,
		},
	],
} as const;
