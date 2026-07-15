export const GOOGLE_SCOPE = {
  openid: 'openid',
  userInfoEmail: 'https://www.googleapis.com/auth/userinfo.email',
  userInfoProfile: 'https://www.googleapis.com/auth/userinfo.profile',
  gmailReadonly: 'https://www.googleapis.com/auth/gmail.readonly',
  gmailCompose: 'https://www.googleapis.com/auth/gmail.compose',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
  gmailModify: 'https://www.googleapis.com/auth/gmail.modify',
  gmailLabels: 'https://www.googleapis.com/auth/gmail.labels',
  gmailSettingsBasic: 'https://www.googleapis.com/auth/gmail.settings.basic',
  driveReadonly: 'https://www.googleapis.com/auth/drive.readonly',
  driveFile: 'https://www.googleapis.com/auth/drive.file',
  driveFull: 'https://www.googleapis.com/auth/drive',
  calendarReadonly: 'https://www.googleapis.com/auth/calendar.readonly',
  calendarEvents: 'https://www.googleapis.com/auth/calendar.events',
  calendarFull: 'https://www.googleapis.com/auth/calendar',
  docsReadonly: 'https://www.googleapis.com/auth/documents.readonly',
  docsFull: 'https://www.googleapis.com/auth/documents',
  sheetsReadonly: 'https://www.googleapis.com/auth/spreadsheets.readonly',
  sheetsFull: 'https://www.googleapis.com/auth/spreadsheets',
  slidesReadonly: 'https://www.googleapis.com/auth/presentations.readonly',
  slidesFull: 'https://www.googleapis.com/auth/presentations',
  formsBodyReadonly: 'https://www.googleapis.com/auth/forms.body.readonly',
  formsBody: 'https://www.googleapis.com/auth/forms.body',
  formsResponsesReadonly: 'https://www.googleapis.com/auth/forms.responses.readonly',
  tasksReadonly: 'https://www.googleapis.com/auth/tasks.readonly',
  tasksFull: 'https://www.googleapis.com/auth/tasks',
  contactsReadonly: 'https://www.googleapis.com/auth/contacts.readonly',
  contactsFull: 'https://www.googleapis.com/auth/contacts',
  chatMessagesReadonly: 'https://www.googleapis.com/auth/chat.messages.readonly',
  chatMessages: 'https://www.googleapis.com/auth/chat.messages',
  chatSpacesReadonly: 'https://www.googleapis.com/auth/chat.spaces.readonly',
  chatSpaces: 'https://www.googleapis.com/auth/chat.spaces',
  scriptProjectsReadonly: 'https://www.googleapis.com/auth/script.projects.readonly',
  scriptProjects: 'https://www.googleapis.com/auth/script.projects',
  scriptDeploymentsReadonly: 'https://www.googleapis.com/auth/script.deployments.readonly',
  scriptDeployments: 'https://www.googleapis.com/auth/script.deployments',
  scriptProcessesReadonly: 'https://www.googleapis.com/auth/script.processes',
  scriptMetrics: 'https://www.googleapis.com/auth/script.metrics',
  scriptExternalRequest: 'https://www.googleapis.com/auth/script.external_request',
  scriptApp: 'https://www.googleapis.com/auth/script.scriptapp',
} as const;

/**
 * Scopes required by the pinned Workspace MCP complete tier. Divo requests
 * these itself; the sidecar never starts or owns an OAuth flow.
 */
export const GOOGLE_WORKSPACE_OAUTH_SCOPES = Object.freeze([
  GOOGLE_SCOPE.openid,
  GOOGLE_SCOPE.userInfoEmail,
  GOOGLE_SCOPE.userInfoProfile,
  GOOGLE_SCOPE.gmailReadonly,
  GOOGLE_SCOPE.gmailCompose,
  GOOGLE_SCOPE.gmailSend,
  GOOGLE_SCOPE.gmailModify,
  GOOGLE_SCOPE.gmailLabels,
  GOOGLE_SCOPE.gmailSettingsBasic,
  GOOGLE_SCOPE.driveReadonly,
  GOOGLE_SCOPE.driveFile,
  GOOGLE_SCOPE.driveFull,
  GOOGLE_SCOPE.calendarReadonly,
  GOOGLE_SCOPE.calendarEvents,
  GOOGLE_SCOPE.calendarFull,
  GOOGLE_SCOPE.docsReadonly,
  GOOGLE_SCOPE.docsFull,
  GOOGLE_SCOPE.sheetsReadonly,
  GOOGLE_SCOPE.sheetsFull,
  GOOGLE_SCOPE.slidesReadonly,
  GOOGLE_SCOPE.slidesFull,
  GOOGLE_SCOPE.formsBodyReadonly,
  GOOGLE_SCOPE.formsBody,
  GOOGLE_SCOPE.formsResponsesReadonly,
  GOOGLE_SCOPE.tasksReadonly,
  GOOGLE_SCOPE.tasksFull,
  GOOGLE_SCOPE.contactsReadonly,
  GOOGLE_SCOPE.contactsFull,
  GOOGLE_SCOPE.chatMessagesReadonly,
  GOOGLE_SCOPE.chatMessages,
  GOOGLE_SCOPE.chatSpacesReadonly,
  GOOGLE_SCOPE.chatSpaces,
  GOOGLE_SCOPE.scriptProjectsReadonly,
  GOOGLE_SCOPE.scriptProjects,
  GOOGLE_SCOPE.scriptDeploymentsReadonly,
  GOOGLE_SCOPE.scriptDeployments,
  GOOGLE_SCOPE.scriptProcessesReadonly,
  GOOGLE_SCOPE.scriptMetrics,
  GOOGLE_SCOPE.scriptExternalRequest,
  GOOGLE_SCOPE.scriptApp,
]);

const SCOPE_IMPLICATIONS = new Map<string, readonly string[]>([
  [GOOGLE_SCOPE.gmailModify, [
    GOOGLE_SCOPE.gmailReadonly,
    GOOGLE_SCOPE.gmailCompose,
    GOOGLE_SCOPE.gmailSend,
    GOOGLE_SCOPE.gmailLabels,
  ]],
  [GOOGLE_SCOPE.driveFull, [GOOGLE_SCOPE.driveReadonly, GOOGLE_SCOPE.driveFile]],
  [GOOGLE_SCOPE.calendarFull, [GOOGLE_SCOPE.calendarReadonly, GOOGLE_SCOPE.calendarEvents]],
  [GOOGLE_SCOPE.docsFull, [GOOGLE_SCOPE.docsReadonly]],
  [GOOGLE_SCOPE.sheetsFull, [GOOGLE_SCOPE.sheetsReadonly]],
  [GOOGLE_SCOPE.slidesFull, [GOOGLE_SCOPE.slidesReadonly]],
  [GOOGLE_SCOPE.formsBody, [GOOGLE_SCOPE.formsBodyReadonly]],
  [GOOGLE_SCOPE.tasksFull, [GOOGLE_SCOPE.tasksReadonly]],
  [GOOGLE_SCOPE.contactsFull, [GOOGLE_SCOPE.contactsReadonly]],
  [GOOGLE_SCOPE.chatMessages, [GOOGLE_SCOPE.chatMessagesReadonly]],
  [GOOGLE_SCOPE.chatSpaces, [GOOGLE_SCOPE.chatSpacesReadonly]],
  [GOOGLE_SCOPE.scriptProjects, [GOOGLE_SCOPE.scriptProjectsReadonly]],
  [GOOGLE_SCOPE.scriptDeployments, [GOOGLE_SCOPE.scriptDeploymentsReadonly]],
]);

function normalizeGoogleScope(scope: string): string {
  const trimmed = scope.trim().toLowerCase().replace(/\/$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('http') || trimmed === 'openid'
    ? trimmed
    : `https://www.googleapis.com/auth/${trimmed}`;
}

/** Every group must have at least one granted (or implied) scope. */
export function hasGoogleScopeGroups(
  grantedScopes: readonly string[],
  requiredGroups: readonly (readonly string[])[],
): boolean {
  if (requiredGroups.length === 0) return true;

  const expanded = new Set(grantedScopes.map(normalizeGoogleScope).filter(Boolean));
  for (const [broader, narrower] of SCOPE_IMPLICATIONS) {
    if (!expanded.has(normalizeGoogleScope(broader))) continue;
    for (const scope of narrower) expanded.add(normalizeGoogleScope(scope));
  }

  return requiredGroups.every((group) =>
    group.some((scope) => expanded.has(normalizeGoogleScope(scope))),
  );
}
