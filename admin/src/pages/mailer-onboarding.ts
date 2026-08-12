const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify"
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"

export type MailerGoogleConnection = {
  ownerType?: string
  access?: string
  scopes?: string[]
  reconnectRequired?: boolean
}

function hasMailerScopes(scopes: readonly string[] = []) {
  const normalized = new Set(scopes.map((scope) => scope.trim().toLowerCase().replace(/\/$/, "")))
  return normalized.has(GMAIL_MODIFY_SCOPE) && normalized.has(GMAIL_SEND_SCOPE)
}

/**
 * Browser authentication and Google authorization have different lifetimes.
 * A returning member only needs Mailer onboarding when their own persisted
 * Google connection is absent or no longer usable.
 */
export function hasUsableMailerConnection(connections: readonly MailerGoogleConnection[] = []) {
  return connections.some((connection) =>
    connection.ownerType === "user"
    && connection.access !== "read_only"
    && !connection.reconnectRequired
    && hasMailerScopes(connection.scopes),
  )
}
