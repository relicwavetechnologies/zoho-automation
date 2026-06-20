export type IntegrationPluginConnectionStatus =
  | 'not_connected'
  | 'connected'
  | 'needs_reconnect'
  | 'revoked'

export type IntegrationPluginCapabilityStatus =
  | 'available'
  | 'needs_connection'
  | 'needs_scope'
  | 'unavailable'

export interface IntegrationPluginScope {
  id: string
  label: string
  description: string
  required: boolean
}

export interface IntegrationPluginManifest {
  id: string
  name: string
  description: string
  category: string
  featured: boolean
  logo_key: string
  auth_model: string
  connector_provider: string
  connection_scope: string
  oauth_scopes: IntegrationPluginScope[]
  capabilities: Array<{
    id: string
    label: string
    description: string
    tool_name: string | null
    required_scopes: string[]
    phase: number
  }>
  examples: string[]
  env_requirements: string[]
}

export interface IntegrationPluginRow {
  id: string
  manifest: IntegrationPluginManifest
  connection: {
    status: IntegrationPluginConnectionStatus
    account_email: string | null
    granted_scopes: string[]
    connected_at: string | null
    credential_id: string | null
  }
  capabilities: Array<{
    id: string
    label: string
    description: string
    tool_name: string | null
    status: IntegrationPluginCapabilityStatus
    phase: number
  }>
  actions: {
    can_connect: boolean
    can_disconnect: boolean
    can_manage_admin: boolean
  }
  admin_stats?: {
    connected_user_count: number
    total_credentials: number
  }
}

export interface IntegrationPluginsResponse {
  company_id: string
  actor: {
    company_user_id: string
    role: string
    is_admin: boolean
  }
  oauth: {
    google_configured: boolean
    redirect_configured: boolean
  }
  plugins: IntegrationPluginRow[]
}

export interface IntegrationPluginOAuthStartResponse {
  authorize_url?: string
  error?: string
  phase?: number
}
