import type { ToolPolicyDescriptor } from '../../../tools/tool-registry';

export type RuntimeToolMap = Record<string, any>;

export type RuntimeToolDefinitionContract = {
  toolId: string;
  runtimeFamily: string;
  policy: ToolPolicyDescriptor;
};

export type ToolFamilyBuilder<THelpers = unknown> = (
  ...args: THelpers extends undefined
    ? []
    : THelpers extends readonly unknown[]
      ? THelpers
      : [helpers: THelpers]
) => RuntimeToolMap;

export type ToolFamilyContract<THelpers = unknown> = {
  familyId: string;
  build: ToolFamilyBuilder<THelpers>;
};

export type RuntimeVercelToolFamilies = {
  contextSearch: RuntimeToolMap;
  documents: RuntimeToolMap;
  workflowAuthoring: RuntimeToolMap;
  repoCoding: RuntimeToolMap;
  google: RuntimeToolMap;
  zohoBooks: RuntimeToolMap;
  larkTask: RuntimeToolMap;
  larkMessaging: RuntimeToolMap;
  larkCollab: RuntimeToolMap;
  zohoCrm: RuntimeToolMap;
  outreach: RuntimeToolMap;
  search: RuntimeToolMap;
};
