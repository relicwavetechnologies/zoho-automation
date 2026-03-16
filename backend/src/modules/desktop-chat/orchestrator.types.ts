export interface BootstrapResult {
  summary: string;
  complexity: 'ambient' | 'simple' | 'structured';
  shouldUseSkills: boolean;
  skillQuery?: string;
  deliverables: string[];
  missingInputs: string[];
  directReply?: string;
  notes: string[];
}

export interface WorkerResult {
  hopIndex: number;
  workerKey: string;
  actionKind: string;
  input: Record<string, unknown>;
  success: boolean;
  hasSubstantiveContent: boolean;
  summary: string;
  keyData: Record<string, unknown>;
  fullPayload: string;
  timestamp: number;
  error?: string;
}

export interface LastActionState {
  workerKey: string;
  actionKind: string;
  success: boolean;
}

export type EngineTerminalState =
  | { type: 'COMPLETE'; reply: string }
  | { type: 'ASK_USER'; question: string }
  | { type: 'FAIL'; reason: string }
  | { type: 'UNKNOWN'; reason?: string };

export interface ChatResponse {
  role: 'assistant';
  content: string;
}
