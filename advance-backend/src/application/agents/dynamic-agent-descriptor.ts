export interface DynamicAgentDescriptor {
  readonly id:                    string;
  readonly companyId:             string;
  readonly slug:                  string;
  readonly name:                  string;
  readonly capabilityDescription: string;
  readonly toolIds:               string[];
  readonly childAgentIds:         string[];
  readonly systemPrompt:          string;
  readonly hookId:                string | null;
  readonly modelId:               string | null;
  readonly provider:              string | null;
  readonly maxSteps:              number;
  readonly temperature:           number;
  readonly isActive:              boolean;
  readonly isRootAgent:           boolean;
  readonly parentId:              string | null;
}
