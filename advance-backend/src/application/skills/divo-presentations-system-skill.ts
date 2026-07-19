import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  provisionDivoProductivitySkillForExistingCompanies,
  provisionDivoProductivitySystemSkill,
  type DivoProductivitySystemSkillDefinition,
} from './divo-productivity-system-skills';

export const DIVO_PRESENTATIONS_SKILL_SLUG = 'divo-presentations';

export const DIVO_PRESENTATIONS_MARKDOWN = `# Divo Presentations

Use this skill when the member wants to plan, create, edit, review, or organize a presentation, slide deck, pitch deck, or speaker narrative.

This is a Divo routing skill. Choose the presentation surface before taking action; do not treat a Google Slides deck and a local PowerPoint file as interchangeable.

## Choose the correct surface

### Google Slides or a connected Google presentation

Use the existing **Google Slides** Divo skill and its governed \`googleSlides\` tool. Never use a local Google CLI, browser automation, curl, or direct Google API.

For an important Google Slides change:

1. Resolve the exact presentation and inspect its current structure.
2. Create once or update the smallest grounded set of elements.
3. Read the changed presentation or page back after the mutation.
4. Use a page thumbnail when visual fidelity matters, then report the canonical Google Slides URL returned by the governed tool.

### Local PPTX read or analysis

For a local \`.pptx\` file, use **Divo Document Intelligence** to extract slide text, tables, and existing speaker notes. Keep any scratch output in Divo artifact directories.

### Local PPTX creation, editing, rendering, or visual QA

These actions are not yet a Divo-owned local capability. Do not imitate an editor by writing Open XML, installing arbitrary packages, using a global presentation CLI, or claiming visual verification.

Offer one of these safe alternatives instead:

- prepare a structured slide outline, content plan, and speaker notes for the member to review;
- create or update a Google Slides presentation through the governed Google route when the member chooses an eligible account;
- read and analyze an existing local PPTX through Divo Document Intelligence.

## Presentation quality

- Start with the audience, decision, desired action, and presentation surface.
- Keep one clear message per slide and make claims traceable to supplied or governed source material.
- Preserve the member's requested structure, brand constraints, and ownership; ask one concise question when the target surface or destination is materially ambiguous.
- Never claim a deck was created, edited, rendered, or visually checked unless the selected execution surface confirmed that exact outcome.`;

export const DIVO_PRESENTATIONS_SYSTEM_SKILL: DivoProductivitySystemSkillDefinition = {
  slug: DIVO_PRESENTATIONS_SKILL_SLUG,
  name: 'Divo Presentations',
  summary: 'Route presentation work to governed Google Slides or local Divo document analysis, and prepare high-quality slide plans without overstating unsupported local PPTX editing.',
  markdown: DIVO_PRESENTATIONS_MARKDOWN,
  // This router must remain visible even when Google Slides is not permitted.
  toolIds: [],
  tags: ['divo', 'productivity', 'presentations', 'slides', 'slide-deck', 'pptx', 'powerpoint', 'create', 'edit'],
  aliases: ['create slides', 'create powerpoint', 'create pptx', 'edit slide deck', 'edit pptx', 'presentation design', 'pptx deck'],
  sortOrder: 20,
};

export async function provisionDivoPresentationsSystemSkill(
  db: Pick<Prisma.TransactionClient, 'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'>,
  companyId: string,
) {
  return provisionDivoProductivitySystemSkill(db, companyId, DIVO_PRESENTATIONS_SYSTEM_SKILL);
}

export async function provisionDivoPresentationsForExistingCompanies(
  db: Pick<PrismaClient, 'company' | 'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'>,
) {
  return provisionDivoProductivitySkillForExistingCompanies(db, DIVO_PRESENTATIONS_SYSTEM_SKILL);
}
