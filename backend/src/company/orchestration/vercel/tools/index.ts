import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../types';
import { buildContextSearchTools } from './families/context-search';
import { buildDocumentTools } from './families/documents';
import { buildGoogleTools } from './families/google';
import { buildLarkCollabTools } from './families/lark-collab';
import { buildLarkMessagingTools } from './families/lark-messaging';
import { buildLarkTaskTools } from './families/lark-task';
import { buildOutreachTools } from './families/outreach';
import { buildRepoCodingTools } from './families/repo-coding';
import { buildWorkflowAuthoringTools } from './families/workflow-authoring';
import { buildZohoBooksTools } from './families/zoho-books';
import { buildZohoCrmTools } from './families/zoho-crm';

export const createVercelDesktopTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
): Record<string, any> => ({
  ...(runtime.delegatedAgentId ? {} : buildContextSearchTools(runtime, hooks)),
  ...buildDocumentTools(runtime, hooks),
  ...buildWorkflowAuthoringTools(runtime, hooks),
  ...buildRepoCodingTools(runtime, hooks),
  ...buildGoogleTools(runtime, hooks),
  ...buildZohoBooksTools(runtime, hooks),
  ...buildLarkTaskTools(runtime, hooks),
  ...buildLarkMessagingTools(runtime, hooks),
  ...buildLarkCollabTools(runtime, hooks),
  ...buildZohoCrmTools(runtime, hooks),
  ...buildOutreachTools(runtime, hooks),
});
