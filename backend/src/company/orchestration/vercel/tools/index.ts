import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../types';
import { buildDocumentTools } from './families/documents';
import { buildGoogleTools } from './families/google';
import { buildLarkCollabTools } from './families/lark-collab';
import { buildLarkTaskTools } from './families/lark-task';
import { buildOutreachTools } from './families/outreach';
import { buildRepoCodingTools } from './families/repo-coding';
import { buildSearchTools } from './families/search';
import { buildZohoBooksTools } from './families/zoho-books';
import { buildZohoCrmTools } from './families/zoho-crm';

export const createVercelDesktopTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
): Record<string, any> => {
  const searchTools = buildSearchTools(runtime, hooks);
  const { skillSearch, ...coreSearchTools } = searchTools;

  return {
    ...coreSearchTools,
    ...buildDocumentTools(runtime, hooks),
    ...(skillSearch ? { skillSearch } : {}),
  ...buildRepoCodingTools(runtime, hooks),
  ...buildGoogleTools(runtime, hooks),
  ...buildZohoBooksTools(runtime, hooks),
  ...buildLarkTaskTools(runtime, hooks),
  ...buildLarkCollabTools(runtime, hooks),
  ...buildZohoCrmTools(runtime, hooks),
  ...buildOutreachTools(runtime, hooks),
  };
};
