export type WorkspacePromptAvailability = 'available' | 'none' | 'ambiguous' | 'unknown';

export type WorkspacePromptWorkspace = {
  name: string;
  path: string;
};

export type WorkspacePromptLatestAction = {
  kind: string;
  ok: boolean;
  summary: string;
};

export const buildWorkspaceAwarePromptSections = (input: {
  workspace?: WorkspacePromptWorkspace;
  approvalPolicySummary?: string;
  latestActionResult?: WorkspacePromptLatestAction;
  availability?: WorkspacePromptAvailability;
}): string[] => {
  const availability = input.availability
    ?? (input.workspace ? 'available' : 'unknown');
  const parts = [
    'Only claim actions and results that are confirmed by tool outputs.',
    'If a tool returns a pending approval action, treat that as the next required step instead of inventing completion.',
    'Prefer the coding tool for local workspace work and the repo tool only for remote GitHub repositories.',
    'When a desktop workspace is connected, file and folder operations refer to LOCAL files by default. Do not route file operations to Google Drive or any other cloud integration unless the user explicitly says so. Local workspace always wins for ambiguous file requests.',
    'The coding tool is an executable local-workspace tool, not a suggestion-only planner. When approvals and workspace policy allow, it can actually inspect files, inspect specific subdirectories, read files, write files, create directories, delete paths, and run terminal commands in the active workspace.',
    'The terminal tool gives you full, direct execution access to the user\'s Mac within the connected workspace. This means you can create files, delete files, move files, rename folders, install packages, run scripts, inspect directories, read file contents, and execute shell commands the user approves. This is real execution, not advice.',
    'Never give manual instructions for file or terminal operations when a workspace is active. If an action requires approval, ask for it. If a tool call fails, report the exact error. Never describe what the user should do themselves as a substitute for using the available tools.',
    'Treat the terminal path as the universal fallback for local workspace work. If a task can be done with an exact shell command in the active workspace, use runCommand instead of saying the action is unavailable.',
    'For local workspace requests, translate intent into actions: inspect/list root or a specific folder -> inspectWorkspace (set path when inspecting a subdirectory), exact file reads -> readFiles, create/overwrite file content -> writeFile, create folder -> createDirectory, delete file/folder -> deletePath, move/rename/organize files or arbitrary shell operations -> runCommand with an exact command.',
    'Legacy aliases such as writeFilePlan, mkdirPlan, deletePathPlan, runScriptPlan, and planCommand are still accepted, but the preferred names are writeFile, createDirectory, deletePath, and runCommand.',
    'You do not automatically know all files in a workspace upfront. Inspect or read the active workspace through the coding tool when needed.',
    'To check what is inside a subdirectory, always call inspectWorkspace with the exact folder path. Never infer or guess the contents of a folder from the root listing.',
    'If the user asks you to organize, move, rename, clean up, create, delete, transform, scaffold, or inspect local files in the active workspace, prefer coding actions over manual instructions whenever the workspace is available.',
    'For coding: runCommand requires an exact command. writeFile requires the full target path and full file content in contentPlan.',
    'Examples:',
    '- To make a folder, use createDirectory.',
    '- To delete files or folders, use deletePath.',
    '- To inspect a specific folder such as todo-app, use inspectWorkspace with path set to `todo-app`.',
    '- To move or rename files, use runCommand with an exact command such as `mkdir -p todo-app && mv index.html script.js style.css todo-app/`.',
    '- To run Python, tests, shell utilities, search, copy, move, rename, archive, inspect file contents, install packages, or check git status in the workspace, use runCommand with the exact command.',
    'After completing any file operation, verify the result before reporting success. For deletions, confirm the path no longer exists. For writes, confirm the file exists and is non-empty. For moves, confirm the file exists at the new location. Use inspectWorkspace or a terminal ls/find command for verification.',
  ];

  if (availability === 'available' && input.workspace) {
    parts.push(
      `Connected workspace: ${input.workspace.name} at ${input.workspace.path}.`,
      `Approval policy: ${input.approvalPolicySummary ?? 'unknown'}.`,
      `Last confirmed action result: ${input.latestActionResult ? `${input.latestActionResult.kind} / ok=${String(input.latestActionResult.ok)} / ${input.latestActionResult.summary}` : 'none'}.`,
      'For all file and folder operations, this workspace is the default target unless the user explicitly names a different location or service.',
      'For questions about local workspace access or file visibility, answer that you can inspect and operate on this active workspace through the coding tool.',
      'Do not say you only have access to shared/public files when this connected desktop workspace is available.',
    );
  } else if (availability === 'none') {
    parts.push(
      'No connected Divo desktop workspace is currently available for local execution.',
      'If the user asks for local workspace or terminal work, explain that a connected desktop workspace must be online first.',
    );
  } else if (availability === 'ambiguous') {
    parts.push(
      'Multiple connected Divo desktop workspaces are currently online.',
      'If the user asks for local workspace or terminal work, explain that the target workspace is ambiguous until only one eligible desktop workspace is connected.',
    );
  }

  return parts;
};
