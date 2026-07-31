import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import type { CanonicalToolId } from '../../domain/tools/tool-id';
import { asToolId } from '../../shared/ids';
import type { PermissionResult } from '../permissions/permission.types';
import type { CatalogSkill, SkillCatalogService } from '../skills/skill-catalog.service';

const GOOGLE_WORKSPACE_ROUTER_SLUG = 'google-workspace-router';

export const GOOGLE_VENDOR_ONBOARDING_PHASE_IDS = [
  'gmail_source',
  'google_contact',
  'calendar_availability',
  'google_doc',
  'google_sheet',
  'calendar_event',
] as const;

export type GoogleVendorOnboardingPhaseId = (typeof GOOGLE_VENDOR_ONBOARDING_PHASE_IDS)[number];

type VendorOnboardingPhaseDefinition = {
  readonly key: GoogleVendorOnboardingPhaseId;
  readonly name: string;
  readonly slug: string;
  readonly toolId: string;
  readonly requiredActions: readonly ToolActionGroup[];
  readonly handoff: {
    readonly produces: readonly string[];
    readonly consumes?: readonly string[];
  };
};

const VENDOR_ONBOARDING_PHASES: readonly VendorOnboardingPhaseDefinition[] = [
  {
    key: 'gmail_source',
    name: 'Gmail source',
    slug: 'google-gmail',
    toolId: 'googleGmail',
    requiredActions: ['read'],
    handoff: {
      produces: ['threadId', 'messageId', 'vendorName', 'vendorEmail', 'vendorSummary'],
    },
  },
  {
    key: 'google_contact',
    name: 'Google Contact',
    slug: 'google-contacts',
    toolId: 'googleContacts',
    requiredActions: ['read'],
    handoff: {
      consumes: ['vendorName', 'vendorEmail'],
      produces: ['contactId', 'contactResourceName'],
    },
  },
  {
    key: 'google_doc',
    name: 'Google Doc brief',
    slug: 'google-docs',
    toolId: 'googleDocs',
    requiredActions: ['create'],
    handoff: {
      consumes: ['vendorName', 'vendorSummary', 'contactResourceName'],
      produces: ['documentId', 'documentUrl'],
    },
  },
  {
    key: 'google_sheet',
    name: 'Google Sheets tracker',
    slug: 'google-sheets',
    toolId: 'googleSheets',
    requiredActions: ['create', 'update'],
    handoff: {
      consumes: ['vendorName', 'vendorEmail', 'contactResourceName', 'documentUrl'],
      produces: ['spreadsheetId', 'spreadsheetUrl'],
    },
  },
  {
    key: 'calendar_availability',
    name: 'Google Calendar availability',
    slug: 'google-calendar',
    toolId: 'googleCalendar',
    requiredActions: ['read'],
    handoff: {
      consumes: ['internalAttendeeEmails'],
      produces: ['timezone', 'availabilityWindow', 'proposedSlots'],
    },
  },
  {
    key: 'calendar_event',
    name: 'Google Calendar event',
    slug: 'google-calendar',
    toolId: 'googleCalendar',
    requiredActions: ['create'],
    handoff: {
      consumes: ['approvedSlot', 'groundedAttendeeEmails', 'documentUrl'],
      produces: ['eventId', 'eventUrl'],
    },
  },
];

const DEFAULT_VENDOR_ONBOARDING_PHASE_IDS = [
  'gmail_source',
  'google_contact',
  'google_doc',
  'google_sheet',
] as const;

export interface GoogleVendorOnboardingPlan {
  readonly parent: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly instructions: string;
  };
  readonly workflow: 'vendor_onboarding';
  readonly connection: {
    readonly status: 'google_workspace_connection_selection_required';
    readonly message: string;
  };
  readonly phases: readonly {
    readonly id: string;
    readonly name: string;
    readonly skillId: string;
    readonly toolId: string;
    readonly requiredActions: readonly ToolActionGroup[];
    readonly handoff: VendorOnboardingPhaseDefinition['handoff'];
  }[];
}

export type GoogleVendorOnboardingResolution =
  | { readonly status: 'ready'; readonly plan: GoogleVendorOnboardingPlan }
  | { readonly status: 'unavailable'; readonly missing: readonly string[] };

/**
 * Returns true only for the narrow onboarding workflow that has a bounded,
 * backend-owned Google phase planner. Every other Google request remains a
 * normal work-resolution and execution problem.
 */
export function isGoogleVendorOnboardingRequest(query: string): boolean {
  return /\bvendor\b/i.test(query) && /\bonboard(?:ing)?\b/i.test(query);
}

/**
 * Derives only the Google phases explicitly requested by the user. Lark and
 * other providers remain separate governed phases and are never added here.
 */
export function deriveGoogleVendorOnboardingPhaseIds(query: string): GoogleVendorOnboardingPhaseId[] {
  const phases: GoogleVendorOnboardingPhaseId[] = [];
  const add = (phase: GoogleVendorOnboardingPhaseId) => {
    if (!phases.includes(phase)) phases.push(phase);
  };

  if (/\b(?:gmail|email|mail|thread|message)\b/i.test(query)) add('gmail_source');
  if (/\bgoogle\s+contacts?\b|\bgoogle\s+address\s*book\b/i.test(query)) add('google_contact');
  if (/\b(?:availability|free[ -]?busy|time\s+slots?)\b|\bcheck\b[^.\n]{0,60}\bcalendar\b/i.test(query)) {
    add('calendar_availability');
  }
  if (/\bgoogle\s+docs?\b|\bdoc(?:ument)?\s+(?:agenda|brief|summary)\b/i.test(query)) add('google_doc');
  if (/\bgoogle\s+sheets?\b|\bspreadsheet\b|\bsheet\s+tracker\b/i.test(query)) add('google_sheet');
  if (/\b(?:create|schedule|approve)\b[^.\n]{0,80}\bcalendar\s+event\b|\bcalendar\s+event\b/i.test(query)) {
    add('calendar_event');
  }

  return phases;
}

/**
 * Builds the Google parent plan from the live, RBAC-filtered DB router and
 * specialist registry.
 */
export async function buildGoogleVendorOnboardingPlan(input: {
  readonly catalog: SkillCatalogService;
  readonly companyId: string;
  readonly departmentId?: string;
  readonly permission: PermissionResult;
  readonly grantedSkillIds?: ReadonlySet<string>;
  readonly phaseIds?: readonly GoogleVendorOnboardingPhaseId[];
}): Promise<{ ok: true; value: GoogleVendorOnboardingPlan } | { ok: false; missing: readonly string[] }> {
  const visible = await input.catalog.listVisible({
    companyId: input.companyId,
    ...(input.departmentId ? { departmentId: input.departmentId } : {}),
    permission: input.permission,
    ...(input.grantedSkillIds ? { grantedSkillIds: input.grantedSkillIds } : {}),
  });
  const bySlug = new Map(visible.map((skill) => [skill.slug, skill]));
  const parent = bySlug.get(GOOGLE_WORKSPACE_ROUTER_SLUG);
  const requestedIds = input.phaseIds ?? DEFAULT_VENDOR_ONBOARDING_PHASE_IDS;
  const byKey = new Map(VENDOR_ONBOARDING_PHASES.map((phase) => [phase.key, phase]));
  const requestedPhases = requestedIds.map((id) => byKey.get(id)!);
  const missing = [
    ...(!parent ? ['Google Workspace router'] : []),
    ...requestedPhases
    .filter((phase) => {
      const skill = bySlug.get(phase.slug);
      const allowedActions = input.permission.allowedActionsByTool.get(asToolId(phase.toolId as CanonicalToolId));
      return !skill || !allowedActions || !phase.requiredActions.every((action) => allowedActions.has(action));
    })
    .map((phase) => phase.name),
  ];
  if (missing.length) return { ok: false, missing };

  const phases = requestedPhases.map((phase) => {
    const skill = bySlug.get(phase.slug)!;
    return {
      id: phase.key,
      name: phase.name,
      skillId: skill.id,
      toolId: phase.toolId,
      requiredActions: phase.requiredActions,
      handoff: phase.handoff,
    };
  });

  return {
    ok: true,
    value: {
      parent: {
        id: parent!.id,
        name: parent!.name,
        description: parent!.description,
        instructions: parent!.instructions,
      },
      workflow: 'vendor_onboarding',
      connection: {
        status: 'google_workspace_connection_selection_required',
        message: 'Before the first executing phase, use connections.list to obtain one exact Google connectionId. Never choose a model default.',
      },
      phases,
    },
  };
}
