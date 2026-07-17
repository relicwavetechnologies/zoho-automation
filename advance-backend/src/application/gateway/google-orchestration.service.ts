import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import type { CanonicalToolId } from '../../domain/tools/tool-id';
import { asToolId } from '../../shared/ids';
import type { PermissionResult } from '../permissions/permission.types';
import type { CatalogSkill, SkillCatalogService } from '../skills/skill-catalog.service';
import { googleSkill } from '../skills/google.skill';
import {
  type GoogleVendorOnboardingPhaseId,
} from './gateway.types';

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
    readonly status: 'requested' | 'google_workspace_connection_selection_required';
    readonly connectionId?: string;
    readonly message: string;
  };
  readonly phases: readonly {
    readonly id: string;
    readonly name: string;
    readonly skillId: string;
    readonly toolId: string;
    readonly requiredActions: readonly ToolActionGroup[];
    readonly handoff: VendorOnboardingPhaseDefinition['handoff'];
    readonly skill?: Pick<CatalogSkill, 'id' | 'slug' | 'name' | 'description' | 'instructions' | 'toolIds' | 'revision'>;
  }[];
}

/**
 * Builds a virtual Google parent plan from the live, RBAC-filtered specialist
 * registry. The source-controlled parent is never materialized as a database
 * skill and never requires every Google product to be granted.
 */
export async function buildGoogleVendorOnboardingPlan(input: {
  readonly catalog: SkillCatalogService;
  readonly companyId: string;
  readonly departmentId?: string;
  readonly permission: PermissionResult;
  readonly grantedSkillIds?: ReadonlySet<string>;
  readonly connectionId?: string;
  readonly phaseIds?: readonly GoogleVendorOnboardingPhaseId[];
}): Promise<{ ok: true; value: GoogleVendorOnboardingPlan } | { ok: false; missing: readonly string[] }> {
  const visible = await input.catalog.listVisible({
    companyId: input.companyId,
    ...(input.departmentId ? { departmentId: input.departmentId } : {}),
    permission: input.permission,
    ...(input.grantedSkillIds ? { grantedSkillIds: input.grantedSkillIds } : {}),
  });
  const bySlug = new Map(visible.map((skill) => [skill.slug, skill]));
  const requestedIds = input.phaseIds ?? DEFAULT_VENDOR_ONBOARDING_PHASE_IDS;
  const byKey = new Map(VENDOR_ONBOARDING_PHASES.map((phase) => [phase.key, phase]));
  const requestedPhases = requestedIds.map((id) => byKey.get(id)!);
  const missing = requestedPhases
    .filter((phase) => {
      const skill = bySlug.get(phase.slug);
      const allowedActions = input.permission.allowedActionsByTool.get(asToolId(phase.toolId as CanonicalToolId));
      return !skill || !allowedActions || !phase.requiredActions.every((action) => allowedActions.has(action));
    })
    .map((phase) => phase.name);
  if (missing.length) return { ok: false, missing };

  const phases = requestedPhases.map((phase, index) => {
    const skill = bySlug.get(phase.slug)!;
    return {
      id: phase.key,
      name: phase.name,
      skillId: skill.id,
      toolId: phase.toolId,
      requiredActions: phase.requiredActions,
      handoff: phase.handoff,
      // One full specialist recipe is enough to start the run. Subsequent
      // phase IDs are exact and intentionally loaded only immediately before
      // their phase, keeping the agent context compact.
      ...(index === 0 ? { skill } : {}),
    };
  });

  return {
    ok: true,
    value: {
      parent: {
        id: googleSkill.id,
        name: googleSkill.name,
        description: googleSkill.description,
        instructions: googleSkill.instructions,
      },
      workflow: 'vendor_onboarding',
      connection: input.connectionId
        ? {
          status: 'requested',
          connectionId: input.connectionId,
          message: 'Use this explicitly selected Google Workspace connection for every phase. Eligibility and scopes are checked at execution time.',
        }
        : {
          status: 'google_workspace_connection_selection_required',
          message: 'Start the first phase without a connectionId. Divo auto-selects only one eligible account; when more than one is eligible it returns the exact account choices for the user to select. Never choose a model default.',
        },
      phases,
    },
  };
}
