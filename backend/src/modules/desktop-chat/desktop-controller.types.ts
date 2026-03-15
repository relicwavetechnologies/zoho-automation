export type ComposerMode = 'fast' | 'high' | 'xtreme';
export type DesktopEngine = 'mastra' | 'langgraph';

export type AttachedFileRef = {
  fileAssetId: string;
  cloudinaryUrl: string;
  mimeType: string;
  fileName: string;
};

export type DesktopWorkspace = {
  name: string;
  path: string;
};

export type DesktopAction =
  | { kind: 'list_files'; path?: string }
  | { kind: 'read_file'; path: string }
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'delete_path'; path: string }
  | { kind: 'run_command'; command: string };

export type ActionResultPayload = {
  kind: DesktopAction['kind'];
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
};

