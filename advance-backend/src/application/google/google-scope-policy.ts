export const GOOGLE_SCOPE = {
  gmailReadonly:  'https://www.googleapis.com/auth/gmail.readonly',
  gmailCompose:   'https://www.googleapis.com/auth/gmail.compose',
  gmailSend:      'https://www.googleapis.com/auth/gmail.send',
  gmailModify:    'https://www.googleapis.com/auth/gmail.modify',
  gmailFull:      'https://mail.google.com/',
  driveReadonly:  'https://www.googleapis.com/auth/drive.readonly',
  driveFile:      'https://www.googleapis.com/auth/drive.file',
  driveFull:      'https://www.googleapis.com/auth/drive',
  calendarReadonly: 'https://www.googleapis.com/auth/calendar.readonly',
  calendarEvents:   'https://www.googleapis.com/auth/calendar.events',
  calendarFull:     'https://www.googleapis.com/auth/calendar',
} as const;

export const GMAIL_READ_SCOPES = [
  GOOGLE_SCOPE.gmailReadonly,
  GOOGLE_SCOPE.gmailModify,
  GOOGLE_SCOPE.gmailFull,
] as const;

export const GMAIL_SEND_SCOPES = [
  GOOGLE_SCOPE.gmailSend,
  GOOGLE_SCOPE.gmailCompose,
  GOOGLE_SCOPE.gmailModify,
  GOOGLE_SCOPE.gmailFull,
] as const;

export const GMAIL_DRAFT_READ_SCOPES = [
  GOOGLE_SCOPE.gmailReadonly,
  GOOGLE_SCOPE.gmailCompose,
  GOOGLE_SCOPE.gmailModify,
  GOOGLE_SCOPE.gmailFull,
] as const;

export const GMAIL_MODIFY_SCOPES = [
  GOOGLE_SCOPE.gmailModify,
  GOOGLE_SCOPE.gmailFull,
] as const;

export const DRIVE_READ_SCOPES = [
  GOOGLE_SCOPE.driveReadonly,
  GOOGLE_SCOPE.driveFile,
  GOOGLE_SCOPE.driveFull,
] as const;

export const DRIVE_WRITE_SCOPES = [
  GOOGLE_SCOPE.driveFile,
  GOOGLE_SCOPE.driveFull,
] as const;

export const CALENDAR_READ_SCOPES = [
  GOOGLE_SCOPE.calendarReadonly,
  GOOGLE_SCOPE.calendarEvents,
  GOOGLE_SCOPE.calendarFull,
] as const;

export const CALENDAR_WRITE_SCOPES = [
  GOOGLE_SCOPE.calendarEvents,
  GOOGLE_SCOPE.calendarFull,
] as const;

function normalizeGoogleScope(scope: string): string {
  const trimmed = scope.trim().toLowerCase().replace(/\/$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('http') ? trimmed : `https://www.googleapis.com/auth/${trimmed}`;
}

export function hasAnyGoogleScope(
  grantedScopes: readonly string[],
  requiredAnyScope: readonly string[],
): boolean {
  if (requiredAnyScope.length === 0) return true;

  const granted = new Set(grantedScopes.map(normalizeGoogleScope).filter(Boolean));
  return requiredAnyScope
    .map(normalizeGoogleScope)
    .some((scope) => granted.has(scope));
}
