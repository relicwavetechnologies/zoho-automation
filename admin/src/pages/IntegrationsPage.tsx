import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link2, Unlink, RefreshCw, Users, Zap } from 'lucide-react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { api } from '../lib/api';
import { toast } from '../components/ui/use-toast';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';

type OnboardingStatus = {
  companyId: string;
  connection: {
    status: string;
    connectedAt: string;
    scopes: string[];
    lastSyncAt?: string;
    providerMode?: string;
    tokenHealth?: {
      status: string;
      accessTokenExpiresAt?: string;
      lastRefreshAt?: string;
    };
  } | null;
  historicalSync: {
    jobId: string;
    status: string;
    progressPercent: number;
    queuedAt: string;
    startedAt?: string;
    finishedAt?: string;
  } | null;
  vectorIndex?: {
    backend: string;
    indexedCount: number;
    healthy: boolean;
  };
  larkBinding?: LarkBindingResult | null;
  larkWorkspaceConfig?: LarkWorkspaceConfigStatus;
  larkDirectorySync?: LarkSyncStatus;
};

type ZohoOAuthConfigStatus = {
  configured: boolean;
  clientId?: string;
  redirectUri?: string;
  accountsBaseUrl?: string;
  apiBaseUrl?: string;
  updatedAt?: string;
};

type ZohoAuthorizeUrlResult = {
  authorizeUrl: string;
  redirectUri: string;
  scopes: string[];
  environment: 'prod' | 'sandbox';
  source: 'company_config' | 'env_fallback';
};

type LarkBindingResult = {
  bindingId: string;
  companyId: string;
  larkTenantKey: string;
  isActive: boolean;
  updatedAt: string;
};

type LarkWorkspaceConfigStatus = {
  configured: boolean;
  companyId?: string;
  appId?: string;
  apiBaseUrl?: string;
  hasVerificationToken?: boolean;
  hasSigningSecret?: boolean;
  hasStaticTenantAccessToken?: boolean;
  updatedAt?: string;
};

type LarkSyncStatus = {
  hasRun: boolean;
  runId?: string;
  trigger?: string;
  status?: string;
  syncedCount?: number;
  adminCount?: number;
  memberCount?: number;
  errorMessage?: string;
  updatedAt?: string;
};

type ChannelIdentity = {
  id: string;
  companyId: string;
  channel: string;
  externalUserId: string;
  externalTenantId: string;
  displayName?: string;
  email?: string;
  larkOpenId?: string;
  larkUserId?: string;
  sourceRoles: string[];
  aiRole: string;
  createdAt: string;
  updatedAt: string;
};

type VectorShareRequest = {
  id: string;
  companyId: string;
  requesterUserId: string;
  requesterChannelIdentityId?: string;
  conversationKey: string;
  status: string;
  reason?: string;
  decisionNote?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  expiresAt?: string;
  promotedVectorCount: number;
  createdAt: string;
  updatedAt: string;
};

export const IntegrationsPage = () => {
  const { token, session } = useAdminAuth();
  const isSuperAdmin = session?.role === 'SUPER_ADMIN';
  const canManageWorkspaceIntegrations = !isSuperAdmin;
  const [workspaceId, setWorkspaceId] = useState('');
  const scopedCompanyId = useMemo(
    () => (isSuperAdmin ? workspaceId.trim() : undefined),
    [workspaceId, isSuperAdmin],
  );
  const requiresWorkspaceSelection = isSuperAdmin && !scopedCompanyId;
  const isScopedReadOnlyView = isSuperAdmin && !!scopedCompanyId;

  const buildQuery = (extra?: string) => {
    const parts: string[] = [];
    if (scopedCompanyId) parts.push(`companyId=${encodeURIComponent(scopedCompanyId)}`);
    if (extra) parts.push(extra);
    return parts.length ? `?${parts.join('&')}` : '';
  };

  const [statusLoading, setStatusLoading] = useState(true);
  const [identitiesLoading, setIdentitiesLoading] = useState(true);
  const [oauthConfigLoading, setOauthConfigLoading] = useState(true);
  const [larkWorkspaceConfigLoading, setLarkWorkspaceConfigLoading] = useState(true);
  const [larkSyncLoading, setLarkSyncLoading] = useState(true);
  const [vectorShareLoading, setVectorShareLoading] = useState(true);

  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [larkBinding, setLarkBinding] = useState<LarkBindingResult | null>(null);
  const [larkWorkspaceConfig, setLarkWorkspaceConfig] = useState<LarkWorkspaceConfigStatus | null>(null);
  const [larkSyncStatus, setLarkSyncStatus] = useState<LarkSyncStatus | null>(null);
  const [oauthConfig, setOauthConfig] = useState<ZohoOAuthConfigStatus | null>(null);
  const [identities, setIdentities] = useState<ChannelIdentity[]>([]);
  const [vectorShareRequests, setVectorShareRequests] = useState<VectorShareRequest[]>([]);
  const [channelFilter, setChannelFilter] = useState<'all' | 'lark' | 'slack' | 'whatsapp'>('all');

  const [larkTenantKey, setLarkTenantKey] = useState('');
  const [larkIsActive, setLarkIsActive] = useState<'true' | 'false'>('true');
  const [larkSaving, setLarkSaving] = useState(false);
  const [larkAppId, setLarkAppId] = useState('');
  const [larkAppSecret, setLarkAppSecret] = useState('');
  const [larkVerificationToken, setLarkVerificationToken] = useState('');
  const [larkSigningSecret, setLarkSigningSecret] = useState('');
  const [larkStaticTenantAccessToken, setLarkStaticTenantAccessToken] = useState('');
  const [larkApiBaseUrl, setLarkApiBaseUrl] = useState('https://open.larksuite.com');
  const [larkConfigSaving, setLarkConfigSaving] = useState(false);
  const [larkConfigDeleting, setLarkConfigDeleting] = useState(false);
  const [larkSyncTriggering, setLarkSyncTriggering] = useState(false);
  const [vectorShareMutatingId, setVectorShareMutatingId] = useState<string | null>(null);

  const [zohoMode, setZohoMode] = useState<'rest' | 'mcp'>('rest');
  const [restCode, setRestCode] = useState('');
  const [restScopes, setRestScopes] = useState('ZohoCRM.modules.ALL');
  const [restEnv, setRestEnv] = useState<'prod' | 'sandbox'>('prod');
  const [mcpBaseUrl, setMcpBaseUrl] = useState('');
  const [mcpApiKey, setMcpApiKey] = useState('');
  const [mcpWorkspaceKey, setMcpWorkspaceKey] = useState('');
  const [mcpAllowedTools, setMcpAllowedTools] = useState('');
  const [mcpEnv, setMcpEnv] = useState<'prod' | 'sandbox'>('prod');
  const [zohoConnecting, setZohoConnecting] = useState(false);
  const [zohoDisconnecting, setZohoDisconnecting] = useState(false);
  const [oauthLaunching, setOauthLaunching] = useState(false);
  const [historicalSyncTriggering, setHistoricalSyncTriggering] = useState(false);

  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [oauthRedirectUri, setOauthRedirectUri] = useState('');
  const [oauthAccountsBaseUrl, setOauthAccountsBaseUrl] = useState('');
  const [oauthApiBaseUrl, setOauthApiBaseUrl] = useState('');
  const [oauthConfigSaving, setOauthConfigSaving] = useState(false);
  const [oauthConfigDeleting, setOauthConfigDeleting] = useState(false);

  const zohoRedirectUri = oauthConfig?.redirectUri || `${window.location.origin}/zoho/callback`;

  const loadStatus = async () => {
    if (!token) return;
    if (isSuperAdmin && !scopedCompanyId) {
      setOnboarding(null);
      setStatusLoading(false);
      return;
    }
    setStatusLoading(true);
    try {
      const status = await api.get<OnboardingStatus>(
        `/api/admin/company/onboarding/status${buildQuery()}`,
        token,
      );
      setOnboarding(status);
      setLarkBinding(status.larkBinding ?? null);
    } catch {
      // Error handled globally by api.ts
    } finally {
      setStatusLoading(false);
    }
  };

  const loadIdentities = async () => {
    if (!token) return;
    if (isSuperAdmin && !scopedCompanyId) {
      setIdentities([]);
      setIdentitiesLoading(false);
      return;
    }
    setIdentitiesLoading(true);
    try {
      const channelParam = channelFilter !== 'all' ? `channel=${channelFilter}` : '';
      const rows = await api.get<ChannelIdentity[]>(
        `/api/admin/company/channel-identities${buildQuery(channelParam)}`,
        token,
      );
      setIdentities(rows);
    } catch {
      // Error handled globally
    } finally {
      setIdentitiesLoading(false);
    }
  };

  const loadZohoOAuthConfig = async () => {
    if (!token) return;
    if (isSuperAdmin && !scopedCompanyId) {
      setOauthConfig(null);
      setOauthConfigLoading(false);
      return;
    }
    setOauthConfigLoading(true);
    try {
      const result = await api.get<ZohoOAuthConfigStatus>(
        `/api/admin/company/onboarding/zoho-oauth-config${buildQuery()}`,
        token,
      );
      setOauthConfig(result);
    } catch {
      setOauthConfig({ configured: false });
    } finally {
      setOauthConfigLoading(false);
    }
  };

  const loadLarkWorkspaceConfig = async () => {
    if (!token) return;
    if (isSuperAdmin && !scopedCompanyId) {
      setLarkWorkspaceConfig(null);
      setLarkWorkspaceConfigLoading(false);
      return;
    }
    setLarkWorkspaceConfigLoading(true);
    try {
      const result = await api.get<LarkWorkspaceConfigStatus>(
        `/api/admin/company/onboarding/lark-workspace-config${buildQuery()}`,
        token,
      );
      setLarkWorkspaceConfig(result);
      if (result.apiBaseUrl) {
        setLarkApiBaseUrl(result.apiBaseUrl);
      }
      if (result.appId) {
        setLarkAppId(result.appId);
      }
    } catch {
      setLarkWorkspaceConfig({ configured: false });
    } finally {
      setLarkWorkspaceConfigLoading(false);
    }
  };

  const loadLarkSyncStatus = async () => {
    if (!token) return;
    if (isSuperAdmin && !scopedCompanyId) {
      setLarkSyncStatus(null);
      setLarkSyncLoading(false);
      return;
    }
    setLarkSyncLoading(true);
    try {
      const result = await api.get<LarkSyncStatus>(
        `/api/admin/company/onboarding/lark-sync/status${buildQuery()}`,
        token,
      );
      setLarkSyncStatus(result);
    } catch {
      setLarkSyncStatus({ hasRun: false });
    } finally {
      setLarkSyncLoading(false);
    }
  };

  const loadVectorShareRequests = async () => {
    if (!token) return;
    if (isSuperAdmin && !scopedCompanyId) {
      setVectorShareRequests([]);
      setVectorShareLoading(false);
      return;
    }
    setVectorShareLoading(true);
    try {
      const result = await api.get<VectorShareRequest[]>(
        `/api/admin/company/vector-share-requests${buildQuery()}`,
        token,
      );
      setVectorShareRequests(result);
    } catch {
      setVectorShareRequests([]);
    } finally {
      setVectorShareLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
    void loadIdentities();
    void loadZohoOAuthConfig();
    void loadLarkWorkspaceConfig();
    void loadLarkSyncStatus();
    void loadVectorShareRequests();
  }, [token, scopedCompanyId, isSuperAdmin]);

  useEffect(() => {
    void loadIdentities();
  }, [channelFilter]);

  useEffect(() => {
    if (!onboarding?.historicalSync) return;
    if (!['queued', 'running'].includes(onboarding.historicalSync.status)) return;
    const interval = window.setInterval(() => { void loadStatus(); }, 5000);
    return () => window.clearInterval(interval);
  }, [onboarding?.historicalSync?.status]);

  useEffect(() => {
    if (!larkSyncStatus?.status) return;
    if (!['queued', 'running'].includes(larkSyncStatus.status)) return;
    const interval = window.setInterval(() => {
      void loadLarkSyncStatus();
      void loadIdentities();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [larkSyncStatus?.status]);

  const saveLarkBinding = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || !larkTenantKey.trim()) return;
    setLarkSaving(true);
    try {
      const result = await api.post<LarkBindingResult>(
        '/api/admin/company/onboarding/lark-binding',
        {
          companyId: scopedCompanyId || undefined,
          larkTenantKey: larkTenantKey.trim(),
          isActive: larkIsActive === 'true',
        },
        token,
      );
      setLarkBinding(result);
      setLarkTenantKey('');
      toast({ title: 'Lark binding saved', description: 'Tenant key bound to this workspace.', variant: 'success' });
    } catch {
      // Error handled globally
    } finally {
      setLarkSaving(false);
    }
  };

  const saveLarkWorkspaceConfig = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    setLarkConfigSaving(true);
    try {
      const result = await api.post<LarkWorkspaceConfigStatus>(
        '/api/admin/company/onboarding/lark-workspace-config',
        {
          companyId: scopedCompanyId || undefined,
          appId: larkAppId.trim(),
          appSecret: larkAppSecret.trim() || undefined,
          verificationToken: larkVerificationToken.trim() || undefined,
          signingSecret: larkSigningSecret.trim() || undefined,
          staticTenantAccessToken: larkStaticTenantAccessToken.trim() || undefined,
          apiBaseUrl: larkApiBaseUrl.trim() || undefined,
        },
        token,
      );
      setLarkWorkspaceConfig(result);
      setLarkAppSecret('');
      setLarkVerificationToken('');
      setLarkSigningSecret('');
      setLarkStaticTenantAccessToken('');
      toast({ title: 'Lark workspace config saved', description: 'Verification and sync credentials updated.', variant: 'success' });
      void loadLarkSyncStatus();
    } catch {
      // Error handled globally
    } finally {
      setLarkConfigSaving(false);
    }
  };

  const deleteLarkWorkspaceConfig = async () => {
    if (!token || !window.confirm('Remove the saved Lark workspace config for this company?')) return;
    setLarkConfigDeleting(true);
    try {
      await api.delete('/api/admin/company/onboarding/lark-workspace-config', { companyId: scopedCompanyId || undefined }, token);
      setLarkWorkspaceConfig({ configured: false });
      toast({ title: 'Lark workspace config removed', variant: 'success' });
    } catch {
      // Error handled globally
    } finally {
      setLarkConfigDeleting(false);
    }
  };

  const triggerLarkUserSync = async () => {
    if (!token) return;
    setLarkSyncTriggering(true);
    try {
      const result = await api.post<{ runId: string; status: string; queued: boolean }>(
        '/api/admin/company/onboarding/lark-sync',
        { companyId: scopedCompanyId || undefined },
        token,
      );
      toast({
        title: result.queued ? 'Lark user sync started' : 'Lark user sync already running',
        description: `Run ID: ${result.runId}`,
        variant: 'success',
      });
      void loadLarkSyncStatus();
    } catch {
      // Error handled globally
    } finally {
      setLarkSyncTriggering(false);
    }
  };

  const connectZohoRest = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    setZohoConnecting(true);
    try {
      await api.post(
        '/api/admin/company/onboarding/connect',
        {
          companyId: scopedCompanyId || undefined,
          mode: 'rest',
          authorizationCode: restCode,
          scopes: restScopes.split(',').map((s) => s.trim()).filter(Boolean),
          environment: restEnv,
        },
        token,
      );
      setRestCode('');
      toast({ title: 'Zoho connected', description: 'Historical data sync has been queued.', variant: 'success' });
      void loadStatus();
    } catch {
      // Error handled globally
    } finally {
      setZohoConnecting(false);
    }
  };

  const connectZohoMcp = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    setZohoConnecting(true);
    try {
      await api.post(
        '/api/admin/company/onboarding/connect',
        {
          companyId: scopedCompanyId || undefined,
          mode: 'mcp',
          mcpBaseUrl: mcpBaseUrl.trim(),
          mcpApiKey: mcpApiKey.trim(),
          mcpWorkspaceKey: mcpWorkspaceKey.trim() || undefined,
          allowedTools: mcpAllowedTools.split(',').map((s) => s.trim()).filter(Boolean),
          environment: mcpEnv,
        },
        token,
      );
      setMcpBaseUrl('');
      setMcpApiKey('');
      setMcpWorkspaceKey('');
      toast({ title: 'Zoho MCP connected', description: 'MCP connection established.', variant: 'success' });
      void loadStatus();
    } catch {
      // Error handled globally
    } finally {
      setZohoConnecting(false);
    }
  };

  const saveZohoOAuthConfig = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    setOauthConfigSaving(true);
    try {
      const result = await api.post<ZohoOAuthConfigStatus>(
        '/api/admin/company/onboarding/zoho-oauth-config',
        {
          companyId: scopedCompanyId || undefined,
          clientId: oauthClientId.trim(),
          clientSecret: oauthClientSecret.trim(),
          redirectUri: oauthRedirectUri.trim(),
          accountsBaseUrl: oauthAccountsBaseUrl.trim() || undefined,
          apiBaseUrl: oauthApiBaseUrl.trim() || undefined,
        },
        token,
      );
      setOauthConfig(result);
      setOauthClientSecret('');
      toast({ title: 'Zoho OAuth app saved', description: 'Credentials encrypted and stored.', variant: 'success' });
    } catch {
      // Error handled globally
    } finally {
      setOauthConfigSaving(false);
    }
  };

  const deleteZohoOAuthConfig = async () => {
    if (!token || !window.confirm('Remove Zoho OAuth app credentials? The connection will fall back to server env vars.')) return;
    setOauthConfigDeleting(true);
    try {
      await api.delete('/api/admin/company/onboarding/zoho-oauth-config', { companyId: scopedCompanyId || undefined }, token);
      setOauthConfig({ configured: false });
      toast({ title: 'Zoho OAuth credentials removed', variant: 'success' });
    } catch {
      // Error handled globally
    } finally {
      setOauthConfigDeleting(false);
    }
  };

  const disconnectZoho = async () => {
    if (!token || !window.confirm('Disconnect Zoho? This will remove all active connections for this workspace.')) return;
    setZohoDisconnecting(true);
    try {
      await api.post(
        '/api/admin/company/onboarding/disconnect',
        { companyId: scopedCompanyId || undefined },
        token,
      );
      toast({ title: 'Zoho disconnected', variant: 'success' });
      void loadStatus();
    } catch {
      // Error handled globally
    } finally {
      setZohoDisconnecting(false);
    }
  };

  const triggerHistoricalSync = async () => {
    if (!token) return;
    setHistoricalSyncTriggering(true);
    try {
      const result = await api.post<{ sync: { status: 'queued' | 'already_queued'; jobId: string } }>(
        '/api/admin/company/onboarding/sync/historical',
        { companyId: scopedCompanyId || undefined },
        token,
      );
      toast({
        title: result.sync.status === 'queued' ? 'Historical sync queued' : 'Historical sync already running',
        description: `Job ID: ${result.sync.jobId}. Existing vectors are preserved and upserted safely.`,
        variant: 'success',
      });
      void loadStatus();
    } catch {
      // Error handled globally
    } finally {
      setHistoricalSyncTriggering(false);
    }
  };

  const approveVectorShareRequest = async (requestId: string) => {
    if (!token) return;
    setVectorShareMutatingId(requestId);
    try {
      await api.post(
        `/api/admin/company/vector-share-requests/${requestId}/approve`,
        { companyId: scopedCompanyId || undefined },
        token,
      );
      toast({ title: 'Share request approved', description: 'Conversation vectors promoted to shared scope.', variant: 'success' });
      void loadVectorShareRequests();
      void loadStatus();
    } catch {
      // Error handled globally
    } finally {
      setVectorShareMutatingId(null);
    }
  };

  const rejectVectorShareRequest = async (requestId: string) => {
    if (!token) return;
    setVectorShareMutatingId(requestId);
    try {
      await api.post(
        `/api/admin/company/vector-share-requests/${requestId}/reject`,
        { companyId: scopedCompanyId || undefined },
        token,
      );
      toast({ title: 'Share request rejected', variant: 'success' });
      void loadVectorShareRequests();
    } catch {
      // Error handled globally
    } finally {
      setVectorShareMutatingId(null);
    }
  };

  const launchZohoOauth = async () => {
    if (isSuperAdmin && !scopedCompanyId) {
      toast({
        title: 'Workspace required',
        description: 'Select a workspace ID first before starting Zoho OAuth.',
        variant: 'destructive',
      });
      return;
    }

    if (!oauthConfig?.configured) {
      toast({
        title: 'Zoho OAuth is not configured',
        description: 'Save Zoho OAuth App credentials in this page first.',
        variant: 'destructive',
      });
      return;
    }

    setOauthLaunching(true);
    try {
      const query = new URLSearchParams();
      if (scopedCompanyId) {
        query.set('companyId', scopedCompanyId);
      }
      query.set('scopes', restScopes);
      query.set('environment', restEnv);

      const result = await api.get<ZohoAuthorizeUrlResult>(
        `/api/admin/company/onboarding/zoho-authorize-url?${query.toString()}`,
        token || undefined,
      );
      window.location.assign(result.authorizeUrl);
    } catch {
      // Error handled globally
      setOauthLaunching(false);
    }
  };

  const zohoConnected = !!onboarding?.connection && onboarding.connection.status !== 'disconnected';

  const tokenHealthColor = (status?: string) => {
    if (status === 'healthy') return 'text-emerald-400';
    if (status === 'expiring') return 'text-amber-400';
    if (status === 'expired' || status === 'failed') return 'text-red-400';
    return 'text-zinc-400';
  };

  if (requiresWorkspaceSelection) {
    return (
      <div className="flex flex-col gap-6 max-w-5xl">
        <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-400 shrink-0">Workspace ID</span>
              <Input
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                placeholder="Paste workspace UUID to inspect integrations"
                className="bg-[#0a0a0a] border-[#222] flex-1"
              />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
          <CardHeader className="border-b border-[#1a1a1a] pb-4">
            <CardTitle className="text-zinc-100">Workspace Integration Diagnostics</CardTitle>
            <CardDescription className="text-zinc-500">
              Super admin access is intentionally scoped. Pick a workspace to inspect its Lark, Zoho, user sync, and memory status without exposing workspace setup controls globally.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="rounded-md border border-dashed border-[#2a2a2a] bg-[#0a0a0a] p-6 text-sm text-zinc-500">
              No workspace selected yet.
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      {isSuperAdmin && (
        <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-400 shrink-0">Workspace ID</span>
              <Input
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                placeholder="Paste workspace UUID to scope this view"
                className="bg-[#0a0a0a] border-[#222] flex-1"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {isScopedReadOnlyView ? (
        <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
          <CardContent className="pt-4 pb-4">
            <div className="rounded-md border border-amber-900/40 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">
              Super admin view is read-only here. Workspace admins own connection, credential, sync, and approval actions.
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Lark Integration */}
      <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
        <CardHeader className="border-b border-[#1a1a1a] pb-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <CardTitle className="text-zinc-100 flex items-center gap-2">
              <Link2 strokeWidth={1.5} className="h-4 w-4 text-zinc-400" />
              Lark Integration
            </CardTitle>
            <CardDescription className="text-zinc-500 mt-1">
              Bind a Lark workspace to this company. The tenant key maps incoming Lark messages to the correct workspace.
            </CardDescription>
          </div>
          {larkBinding ? (
            <Badge
              variant="secondary"
              className={`shrink-0 ${larkBinding.isActive ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/40' : 'bg-[#1a1a1a] text-zinc-500'}`}
            >
              {larkBinding.isActive ? 'Active' : 'Inactive'}
            </Badge>
          ) : null}
        </CardHeader>
        <CardContent className="pt-6 space-y-5">
          {larkBinding ? (
            <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-md p-4 grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Tenant Key</span>
                <span className="text-zinc-200 font-mono text-xs break-all">{larkBinding.larkTenantKey}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Binding ID</span>
                <span className="text-zinc-500 font-mono text-xs">{larkBinding.bindingId}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Status</span>
                <span className={`text-xs font-medium ${larkBinding.isActive ? 'text-emerald-400' : 'text-zinc-500'}`}>
                  {larkBinding.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Last Updated</span>
                <span className="text-zinc-500 text-xs">{new Date(larkBinding.updatedAt).toLocaleString()}</span>
              </div>
            </div>
          ) : null}

          {canManageWorkspaceIntegrations ? (
            <form
              className="flex flex-col gap-3 p-4 rounded-md border border-[#222] bg-[#0c0c0c]"
              onSubmit={saveLarkBinding}
            >
              <span className="text-sm font-medium text-zinc-300">
                {larkBinding ? 'Update Binding' : 'Set Up Lark Binding'}
              </span>
              <p className="text-xs text-zinc-500 leading-relaxed">
                The tenant key identifies your Lark workspace. Find it in your Lark webhook payload under the{' '}
                <code className="bg-[#1a1a1a] px-1 rounded text-zinc-300 text-[11px]">tenant_key</code> field, or via
                the Lark Open Platform console.
              </p>
              <div className="space-y-1">
                <label className="text-xs text-zinc-500">Lark Tenant Key</label>
                <Input
                  value={larkTenantKey}
                  onChange={(e) => setLarkTenantKey(e.target.value)}
                  placeholder="e.g. 150707d30199d743"
                  className="bg-[#0a0a0a] border-[#222]"
                  required
                />
              </div>
              <div className="flex items-center gap-3">
                <div className="space-y-1 flex-1">
                  <label className="text-xs text-zinc-500">Binding State</label>
                  <Select value={larkIsActive} onValueChange={(val) => setLarkIsActive(val as 'true' | 'false')}>
                    <SelectTrigger className="bg-[#0a0a0a] border-[#222]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[#111] border-[#222] text-zinc-300">
                      <SelectItem value="true">Active — messages from this workspace will be processed</SelectItem>
                      <SelectItem value="false">Inactive — binding saved but messages will be rejected</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="submit"
                  disabled={larkSaving}
                  className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200 mt-5 shrink-0"
                >
                  {larkSaving ? 'Saving…' : larkBinding ? 'Update' : 'Save Binding'}
                </Button>
              </div>
            </form>
          ) : (
            <div className="rounded-md border border-dashed border-[#2a2a2a] bg-[#0c0c0c] px-4 py-3 text-sm text-zinc-500">
              Binding changes are intentionally hidden from super admin. Use a workspace-admin session to change tenant mapping.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lark Workspace Config */}
      <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
        <CardHeader className="border-b border-[#1a1a1a] pb-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <CardTitle className="text-zinc-100 flex items-center gap-2">
              <Zap strokeWidth={1.5} className="h-4 w-4 text-zinc-400" />
              Lark Workspace Credentials
            </CardTitle>
            <CardDescription className="text-zinc-500 mt-1">
              Company-scoped verification and directory-sync credentials. These are used before any env fallback.
            </CardDescription>
          </div>
          {larkWorkspaceConfigLoading ? (
            <Skeleton className="h-5 w-24 shrink-0" />
          ) : (
            <div className="flex items-center gap-2 shrink-0">
              <Badge
                variant="secondary"
                className={`${larkWorkspaceConfig?.configured ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/40' : 'bg-[#111] border border-[#333] text-zinc-500'}`}
              >
                {larkWorkspaceConfig?.configured ? 'Configured' : 'Not Configured'}
              </Badge>
              {larkWorkspaceConfig?.configured && canManageWorkspaceIntegrations ? (
                <button
                  type="button"
                  onClick={() => void deleteLarkWorkspaceConfig()}
                  disabled={larkConfigDeleting}
                  className="text-xs text-red-500 hover:text-red-400 disabled:opacity-50"
                >
                  {larkConfigDeleting ? 'Removing…' : 'Remove'}
                </button>
              ) : null}
            </div>
          )}
        </CardHeader>
        <CardContent className="pt-6 space-y-5">
          {larkWorkspaceConfig?.configured && !larkWorkspaceConfigLoading ? (
            <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-md p-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 text-sm">
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">App ID</span>
                <span className="text-zinc-200 font-mono text-xs break-all">{larkWorkspaceConfig.appId}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">API Base URL</span>
                <span className="text-zinc-400 text-xs break-all">{larkWorkspaceConfig.apiBaseUrl}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Verification Token</span>
                <span className="text-zinc-400 text-xs">{larkWorkspaceConfig.hasVerificationToken ? 'Stored' : 'Missing'}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Signing Secret</span>
                <span className="text-zinc-400 text-xs">{larkWorkspaceConfig.hasSigningSecret ? 'Stored' : 'Missing'}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Static Tenant Token</span>
                <span className="text-zinc-400 text-xs">{larkWorkspaceConfig.hasStaticTenantAccessToken ? 'Stored' : 'Not set'}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Last Updated</span>
                <span className="text-zinc-500 text-xs">
                  {larkWorkspaceConfig.updatedAt ? new Date(larkWorkspaceConfig.updatedAt).toLocaleString() : '—'}
                </span>
              </div>
            </div>
          ) : null}

          {canManageWorkspaceIntegrations ? (
            <form className="flex flex-col gap-4 p-4 rounded-md border border-[#222] bg-[#0c0c0c]" onSubmit={saveLarkWorkspaceConfig}>
              <span className="text-sm font-medium text-zinc-300">
                {larkWorkspaceConfig?.configured ? 'Update Workspace Credentials' : 'Add Workspace Credentials'}
              </span>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-500">App ID</label>
                  <Input
                    value={larkAppId}
                    onChange={(e) => setLarkAppId(e.target.value)}
                    placeholder="cli_xxxxxxxxxxxxx"
                    className="bg-[#0a0a0a] border-[#222]"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-500">
                    App Secret {larkWorkspaceConfig?.configured ? <span className="text-zinc-600">(leave blank to keep existing)</span> : null}
                  </label>
                  <Input
                    value={larkAppSecret}
                    onChange={(e) => setLarkAppSecret(e.target.value)}
                    type="password"
                    placeholder={larkWorkspaceConfig?.configured ? '••••••••••••' : 'Lark app secret'}
                    className="bg-[#0a0a0a] border-[#222]"
                    required={!larkWorkspaceConfig?.configured}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-500">Verification Token (optional if signing secret set)</label>
                  <Input
                    value={larkVerificationToken}
                    onChange={(e) => setLarkVerificationToken(e.target.value)}
                    placeholder="Verification token from Lark event subscription"
                    className="bg-[#0a0a0a] border-[#222]"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-500">Signing Secret (optional if verification token set)</label>
                  <Input
                    value={larkSigningSecret}
                    onChange={(e) => setLarkSigningSecret(e.target.value)}
                    placeholder="Event subscription signing secret"
                    className="bg-[#0a0a0a] border-[#222]"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-500">Static Tenant Access Token (optional)</label>
                  <Input
                    value={larkStaticTenantAccessToken}
                    onChange={(e) => setLarkStaticTenantAccessToken(e.target.value)}
                    type="password"
                    placeholder="Only use if app credential flow is unavailable"
                    className="bg-[#0a0a0a] border-[#222]"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-500">API Base URL</label>
                  <Input
                    value={larkApiBaseUrl}
                    onChange={(e) => setLarkApiBaseUrl(e.target.value)}
                    placeholder="https://open.larksuite.com"
                    className="bg-[#0a0a0a] border-[#222]"
                  />
                </div>
              </div>
              <Button type="submit" disabled={larkConfigSaving} className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200">
                {larkConfigSaving ? 'Saving…' : larkWorkspaceConfig?.configured ? 'Update Credentials' : 'Save Credentials'}
              </Button>
            </form>
          ) : (
            <div className="rounded-md border border-dashed border-[#2a2a2a] bg-[#0c0c0c] px-4 py-3 text-sm text-zinc-500">
              Stored credential status is visible here, but secret rotation and verification updates require a workspace-admin session.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lark Directory Sync */}
      <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
        <CardHeader className="border-b border-[#1a1a1a] pb-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <CardTitle className="text-zinc-100 flex items-center gap-2">
              <Users strokeWidth={1.5} className="h-4 w-4 text-zinc-400" />
              Lark User Directory Sync
            </CardTitle>
            <CardDescription className="text-zinc-500 mt-1">
              Runs on setup, nightly, and manually. Syncs users into company channel identities.
            </CardDescription>
          </div>
          {canManageWorkspaceIntegrations ? (
            <Button
              type="button"
              variant="outline"
              disabled={larkSyncTriggering || !larkWorkspaceConfig?.configured || !larkBinding?.isActive}
              onClick={() => void triggerLarkUserSync()}
              className="border-[#2a2a2a] text-zinc-300 hover:bg-[#1a1a1a] shrink-0"
            >
              {larkSyncTriggering ? 'Starting…' : 'Re-sync users'}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="pt-6">
          {larkSyncLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="p-4 rounded-md bg-[#0a0a0a] border border-[#1a1a1a] flex flex-col gap-2 h-[84px]">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-4 w-24" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="p-4 rounded-md bg-[#0a0a0a] border border-[#1a1a1a] flex flex-col gap-1.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Status</span>
                <span className="text-sm text-zinc-200">{larkSyncStatus?.hasRun ? larkSyncStatus.status : 'Not started'}</span>
                {larkSyncStatus?.updatedAt ? <span className="text-xs text-zinc-600">{new Date(larkSyncStatus.updatedAt).toLocaleString()}</span> : null}
              </div>
              <div className="p-4 rounded-md bg-[#0a0a0a] border border-[#1a1a1a] flex flex-col gap-1.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Trigger</span>
                <span className="text-sm text-zinc-200">{larkSyncStatus?.trigger ?? '—'}</span>
                <span className="text-xs text-zinc-600">Users: {larkSyncStatus?.syncedCount ?? 0}</span>
              </div>
              <div className="p-4 rounded-md bg-[#0a0a0a] border border-[#1a1a1a] flex flex-col gap-1.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Admins / Members</span>
                <span className="text-sm text-zinc-200">{larkSyncStatus?.adminCount ?? 0} / {larkSyncStatus?.memberCount ?? 0}</span>
              </div>
              <div className="p-4 rounded-md bg-[#0a0a0a] border border-[#1a1a1a] flex flex-col gap-1.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Last Error</span>
                <span className="text-xs text-red-400 line-clamp-3">{larkSyncStatus?.errorMessage ?? '—'}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Zoho OAuth App Credentials */}
      <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
        <CardHeader className="border-b border-[#1a1a1a] pb-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <CardTitle className="text-zinc-100 flex items-center gap-2">
              <Users strokeWidth={1.5} className="h-4 w-4 text-zinc-400" />
              Vector Share Requests
            </CardTitle>
            <CardDescription className="text-zinc-500 mt-1">
              Pending conversation-share requests. Approving promotes personal chat vectors into shared company memory.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadVectorShareRequests()}
            className="border-[#2a2a2a] text-zinc-300 hover:bg-[#1a1a1a] shrink-0"
          >
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="pt-6">
          {vectorShareLoading ? (
            <div className="space-y-3">
              {[1, 2].map((i) => (
                <div key={i} className="rounded-md border border-[#1a1a1a] bg-[#0a0a0a] p-4">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-full mt-2" />
                </div>
              ))}
            </div>
          ) : vectorShareRequests.length === 0 ? (
            <div className="rounded-md border border-dashed border-[#2a2a2a] bg-[#0a0a0a] p-6 text-sm text-zinc-500">
              No vector share requests yet.
            </div>
          ) : (
            <div className="space-y-3">
              {vectorShareRequests.map((request) => (
                <div
                  key={request.id}
                  className="rounded-md border border-[#1a1a1a] bg-[#0a0a0a] p-4 flex flex-col gap-3"
                >
                  <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-zinc-100 font-medium">{request.status}</span>
                        <span className="text-[11px] text-zinc-600 font-mono">{request.id}</span>
                      </div>
                      <div className="text-xs text-zinc-500 font-mono break-all">
                        conversation: {request.conversationKey}
                      </div>
                      <div className="text-xs text-zinc-500">
                        requester: {request.requesterChannelIdentityId || request.requesterUserId}
                      </div>
                      {request.reason ? (
                        <div className="text-xs text-zinc-400">Reason: {request.reason}</div>
                      ) : null}
                    </div>
                    <div className="text-xs text-zinc-500">
                      Created {new Date(request.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {canManageWorkspaceIntegrations ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          disabled={request.status !== 'pending' || vectorShareMutatingId === request.id}
                          onClick={() => void approveVectorShareRequest(request.id)}
                          className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200"
                        >
                          {vectorShareMutatingId === request.id ? 'Working…' : 'Approve'}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={request.status !== 'pending' || vectorShareMutatingId === request.id}
                          onClick={() => void rejectVectorShareRequest(request.id)}
                          className="border-[#2a2a2a] text-zinc-300 hover:bg-[#1a1a1a]"
                        >
                          Reject
                        </Button>
                      </>
                    ) : null}
                    {request.status !== 'pending' ? (
                      <span className="text-xs text-zinc-500">
                        reviewed {request.reviewedAt ? new Date(request.reviewedAt).toLocaleString() : '—'}
                      </span>
                    ) : null}
                    {request.promotedVectorCount > 0 ? (
                      <span className="text-xs text-zinc-500">
                        promoted {request.promotedVectorCount} vectors
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
        <CardHeader className="border-b border-[#1a1a1a] pb-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <CardTitle className="text-zinc-100 flex items-center gap-2">
              <Zap strokeWidth={1.5} className="h-4 w-4 text-zinc-400" />
              Zoho OAuth App
            </CardTitle>
            <CardDescription className="text-zinc-500 mt-1">
              Per-workspace Zoho OAuth app credentials. These are encrypted and stored in the database — no server env vars needed.
            </CardDescription>
          </div>
          {oauthConfigLoading ? (
            <Skeleton className="h-5 w-24 shrink-0" />
          ) : (
            <div className="flex items-center gap-2 shrink-0">
              <Badge
                variant="secondary"
                className={`${oauthConfig?.configured ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/40' : 'bg-[#111] border border-[#333] text-zinc-500'}`}
              >
                {oauthConfig?.configured ? 'Configured' : 'Not Configured'}
              </Badge>
              {oauthConfig?.configured && canManageWorkspaceIntegrations && (
                <button
                  type="button"
                  onClick={() => void deleteZohoOAuthConfig()}
                  disabled={oauthConfigDeleting}
                  className="text-xs text-red-500 hover:text-red-400 disabled:opacity-50"
                >
                  {oauthConfigDeleting ? 'Removing…' : 'Remove'}
                </button>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent className="pt-6 space-y-5">
          {oauthConfig?.configured && !oauthConfigLoading ? (
            <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-md p-4 grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Client ID</span>
                <span className="text-zinc-200 font-mono text-xs break-all">{oauthConfig.clientId}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Client Secret</span>
                <span className="text-zinc-500 text-xs">••••••••••••</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Redirect URI</span>
                <span className="text-zinc-400 text-xs break-all">{oauthConfig.redirectUri}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Last Updated</span>
                <span className="text-zinc-500 text-xs">{oauthConfig.updatedAt ? new Date(oauthConfig.updatedAt).toLocaleString() : '—'}</span>
              </div>
              <div className="flex flex-col gap-0.5 col-span-2">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Accounts Base URL</span>
                <span className="text-zinc-500 text-xs">{oauthConfig.accountsBaseUrl}</span>
              </div>
            </div>
          ) : null}

          {canManageWorkspaceIntegrations ? (
            <form className="flex flex-col gap-4 p-4 rounded-md border border-[#222] bg-[#0c0c0c]" onSubmit={saveZohoOAuthConfig}>
              <span className="text-sm font-medium text-zinc-300">
                {oauthConfig?.configured ? 'Update Credentials' : 'Add Zoho OAuth App'}
              </span>
              <p className="text-xs text-zinc-500 leading-relaxed">
                Create a Zoho OAuth app at <span className="text-zinc-300">api-console.zoho.com</span>, set the redirect URI, and paste the credentials here.
                The client secret is encrypted with AES-256-GCM before storage.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-500">Client ID</label>
                  <Input
                    value={oauthClientId}
                    onChange={(e) => setOauthClientId(e.target.value)}
                    placeholder="1000.XXXXXXXXXXXXXXXXXXXXXX"
                    className="bg-[#0a0a0a] border-[#222]"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-500">
                    Client Secret {oauthConfig?.configured ? <span className="text-zinc-600">(leave blank to keep existing)</span> : null}
                  </label>
                  <Input
                    value={oauthClientSecret}
                    onChange={(e) => setOauthClientSecret(e.target.value)}
                    placeholder={oauthConfig?.configured ? '••••••••••••' : 'Your Zoho client secret'}
                    type="password"
                    className="bg-[#0a0a0a] border-[#222]"
                    required={!oauthConfig?.configured}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-500">Redirect URI</label>
                <Input
                  value={oauthRedirectUri}
                  onChange={(e) => setOauthRedirectUri(e.target.value)}
                  placeholder="https://yourapp.com/zoho/callback"
                  className="bg-[#0a0a0a] border-[#222]"
                  required
                />
                <p className="text-[11px] text-zinc-600">Must match exactly what is registered in the Zoho OAuth app.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-500">Accounts Base URL (optional)</label>
                  <Input
                    value={oauthAccountsBaseUrl}
                    onChange={(e) => setOauthAccountsBaseUrl(e.target.value)}
                    placeholder="https://accounts.zoho.com"
                    className="bg-[#0a0a0a] border-[#222]"
                  />
                  <p className="text-[11px] text-zinc-600">Change for regional deployments (e.g. .eu, .in, .com.au).</p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-500">API Base URL (optional)</label>
                  <Input
                    value={oauthApiBaseUrl}
                    onChange={(e) => setOauthApiBaseUrl(e.target.value)}
                    placeholder="https://www.zohoapis.com"
                    className="bg-[#0a0a0a] border-[#222]"
                  />
                </div>
              </div>
              <Button
                type="submit"
                disabled={oauthConfigSaving}
                className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200"
              >
                {oauthConfigSaving ? 'Saving…' : oauthConfig?.configured ? 'Update Credentials' : 'Save Credentials'}
              </Button>
            </form>
          ) : (
            <div className="rounded-md border border-dashed border-[#2a2a2a] bg-[#0c0c0c] px-4 py-3 text-sm text-zinc-500">
              OAuth application metadata stays visible for audits, but credential changes are restricted to workspace-admin sessions.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Zoho CRM */}
      <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
        <CardHeader className="border-b border-[#1a1a1a] pb-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <CardTitle className="text-zinc-100 flex items-center gap-2">
              <Zap strokeWidth={1.5} className="h-4 w-4 text-zinc-400" />
              Zoho CRM
            </CardTitle>
            <CardDescription className="text-zinc-500 mt-1">
              Connect Zoho CRM to power the retrieval and action agents. Supports OAuth (REST) and MCP connection modes.
            </CardDescription>
          </div>
          {statusLoading ? (
            <Skeleton className="h-5 w-24 shrink-0" />
          ) : (
            <Badge
              variant="secondary"
              className={`shrink-0 ${zohoConnected ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/40' : 'bg-[#111] border border-[#333] text-zinc-500'}`}
            >
              {zohoConnected ? 'Connected' : 'Not Connected'}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="pt-6 space-y-5">
          {statusLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="p-4 rounded-md bg-[#0a0a0a] border border-[#1a1a1a] flex flex-col gap-2 h-[88px]">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-32" />
                </div>
              ))}
            </div>
          ) : onboarding ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="p-4 rounded-md bg-[#0a0a0a] border border-[#1a1a1a] flex flex-col gap-1.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Connection</span>
                <span className={`text-sm font-medium ${zohoConnected ? 'text-emerald-400' : 'text-zinc-400'}`}>
                  {onboarding.connection?.status ?? 'NOT_CONNECTED'}
                </span>
                {onboarding.connection?.providerMode ? (
                  <span className="text-xs text-zinc-500">Mode: {onboarding.connection.providerMode}</span>
                ) : null}
                {onboarding.connection?.tokenHealth ? (
                  <span className={`text-xs font-medium ${tokenHealthColor(onboarding.connection.tokenHealth.status)}`}>
                    Token: {onboarding.connection.tokenHealth.status}
                  </span>
                ) : null}
              </div>
              <div className="p-4 rounded-md bg-[#0a0a0a] border border-[#1a1a1a] flex flex-col gap-1.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Historical Sync</span>
                <span className="text-sm text-zinc-200">
                  {onboarding.historicalSync?.status ?? 'Not started'}
                </span>
                {onboarding.historicalSync ? (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1 bg-[#1a1a1a] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-600 rounded-full transition-all"
                        style={{ width: `${onboarding.historicalSync.progressPercent}%` }}
                      />
                    </div>
                    <span className="text-xs text-zinc-500 shrink-0">{onboarding.historicalSync.progressPercent}%</span>
                  </div>
                ) : null}
                {onboarding.connection?.lastSyncAt ? (
                  <span className="text-xs text-zinc-600">
                    Last sync: {new Date(onboarding.connection.lastSyncAt).toLocaleString()}
                  </span>
                ) : null}
                {canManageWorkspaceIntegrations ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={historicalSyncTriggering || !zohoConnected}
                    onClick={() => void triggerHistoricalSync()}
                    className="mt-2 border-[#2a2a2a] text-zinc-300 hover:bg-[#1a1a1a] w-fit"
                  >
                    {historicalSyncTriggering ? 'Queuing…' : 'Retry / Re-sync'}
                  </Button>
                ) : null}
                <span className="text-[11px] text-zinc-600">
                  Safe mode: keeps existing vectors and upserts latest chunks.
                </span>
              </div>
              <div className="p-4 rounded-md bg-[#0a0a0a] border border-[#1a1a1a] flex flex-col gap-1.5">
                <span className="text-[11px] text-zinc-600 uppercase tracking-wide">Vector Index</span>
                <span className="text-sm text-zinc-200">
                  {onboarding.vectorIndex?.indexedCount?.toLocaleString() ?? 0} documents
                </span>
                <span
                  className={`text-xs font-medium ${onboarding.vectorIndex?.healthy ? 'text-emerald-400' : 'text-red-400'}`}
                >
                  {onboarding.vectorIndex?.healthy ? 'Healthy' : 'Degraded'}
                </span>
              </div>
            </div>
          ) : (
            isSuperAdmin && !scopedCompanyId ? (
              <p className="text-sm text-zinc-500 italic p-3 rounded bg-[#0a0a0a] border border-dashed border-[#222]">
                Enter a workspace ID above to view Zoho status.
              </p>
            ) : null
          )}

          {zohoConnected && canManageWorkspaceIntegrations && (
            <div className="flex justify-end">
              <Button
                variant="outline"
                onClick={() => void disconnectZoho()}
                disabled={zohoDisconnecting}
                className="border-red-900/50 text-red-400 hover:bg-red-950/30 hover:text-red-300 gap-2"
              >
                <Unlink strokeWidth={1.5} className="h-4 w-4" />
                {zohoDisconnecting ? 'Disconnecting…' : 'Disconnect Zoho'}
              </Button>
            </div>
          )}

          {canManageWorkspaceIntegrations ? (
            <div className="border border-[#222] rounded-md p-4 bg-[#0c0c0c]">
              <p className="text-sm font-medium text-zinc-300 mb-4">
                {zohoConnected ? 'Reconnect / Update Connection' : 'New Connection Setup'}
              </p>
              <Tabs value={zohoMode} onValueChange={(val) => setZohoMode(val as 'rest' | 'mcp')}>
                <TabsList className="bg-[#0a0a0a] border border-[#1a1a1a] mb-5 h-8">
                  <TabsTrigger
                    value="rest"
                    className="text-xs data-[state=active]:bg-[#1a1a1a] data-[state=active]:text-zinc-100 text-zinc-500"
                  >
                    OAuth (REST)
                  </TabsTrigger>
                  <TabsTrigger
                    value="mcp"
                    className="text-xs data-[state=active]:bg-[#1a1a1a] data-[state=active]:text-zinc-100 text-zinc-500"
                  >
                    MCP
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="rest">
                  <form className="flex flex-col gap-4" onSubmit={connectZohoRest}>
                    <div className="space-y-2 rounded-md border border-[#222] bg-[#0a0a0a] p-3">
                      <p className="text-xs text-zinc-400">
                        Preferred flow: click <span className="text-zinc-200 font-medium">Start Zoho OAuth</span>. You will return to
                        <code className="ml-1 bg-[#1a1a1a] px-1.5 py-0.5 rounded text-[11px]">{zohoRedirectUri}</code>
                        and connection will complete automatically.
                      </p>
                      <Button
                        type="button"
                        onClick={() => void launchZohoOauth()}
                        disabled={oauthLaunching || !oauthConfig?.configured}
                        className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200"
                      >
                        {oauthLaunching ? 'Redirecting…' : 'Start Zoho OAuth'}
                      </Button>
                      {!oauthConfig?.configured ? (
                        <p className="text-[11px] text-amber-400">
                          Save Zoho OAuth App credentials above to enable one-click OAuth launch.
                        </p>
                      ) : null}
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs text-zinc-500">Authorization Code</label>
                      <Input
                        value={restCode}
                        onChange={(e) => setRestCode(e.target.value)}
                        placeholder="Paste Zoho OAuth authorization code"
                        className="bg-[#0a0a0a] border-[#222]"
                        required
                      />
                      <p className="text-[11px] text-zinc-600">
                        Obtain via the Zoho OAuth flow. The code is single-use and expires after 60 seconds.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs text-zinc-500">Scopes (comma-separated)</label>
                      <Input
                        value={restScopes}
                        onChange={(e) => setRestScopes(e.target.value)}
                        placeholder="ZohoCRM.modules.ALL,ZohoCRM.settings.ALL"
                        className="bg-[#0a0a0a] border-[#222]"
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs text-zinc-500">Environment</label>
                      <Select value={restEnv} onValueChange={(val) => setRestEnv(val as 'prod' | 'sandbox')}>
                        <SelectTrigger className="bg-[#0a0a0a] border-[#222]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-[#111] border-[#222] text-zinc-300">
                          <SelectItem value="prod">Production</SelectItem>
                          <SelectItem value="sandbox">Sandbox</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      type="submit"
                      disabled={zohoConnecting}
                      className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200"
                    >
                      {zohoConnecting ? 'Connecting…' : 'Connect via OAuth'}
                    </Button>
                  </form>
                </TabsContent>

                <TabsContent value="mcp">
                  <form className="flex flex-col gap-4" onSubmit={connectZohoMcp}>
                    <div className="space-y-1.5">
                      <label className="text-xs text-zinc-500">MCP Base URL</label>
                      <Input
                        value={mcpBaseUrl}
                        onChange={(e) => setMcpBaseUrl(e.target.value)}
                        placeholder="https://your-mcp-server.com/api"
                        className="bg-[#0a0a0a] border-[#222]"
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs text-zinc-500">API Key</label>
                      <Input
                        value={mcpApiKey}
                        onChange={(e) => setMcpApiKey(e.target.value)}
                        placeholder="MCP API key"
                        type="password"
                        className="bg-[#0a0a0a] border-[#222]"
                        required
                      />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-xs text-zinc-500">Workspace Key (optional)</label>
                        <Input
                          value={mcpWorkspaceKey}
                          onChange={(e) => setMcpWorkspaceKey(e.target.value)}
                          placeholder="MCP workspace key"
                          className="bg-[#0a0a0a] border-[#222]"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs text-zinc-500">Environment</label>
                        <Select value={mcpEnv} onValueChange={(val) => setMcpEnv(val as 'prod' | 'sandbox')}>
                          <SelectTrigger className="bg-[#0a0a0a] border-[#222]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-[#111] border-[#222] text-zinc-300">
                            <SelectItem value="prod">Production</SelectItem>
                            <SelectItem value="sandbox">Sandbox</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs text-zinc-500">Allowed Tools (comma-separated, optional)</label>
                      <Input
                        value={mcpAllowedTools}
                        onChange={(e) => setMcpAllowedTools(e.target.value)}
                        placeholder="search_contacts,get_deals,list_accounts"
                        className="bg-[#0a0a0a] border-[#222]"
                      />
                      <p className="text-[11px] text-zinc-600">
                        Leave blank to allow all tools exposed by the MCP server.
                      </p>
                    </div>
                    <Button
                      type="submit"
                      disabled={zohoConnecting}
                      className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200"
                    >
                      {zohoConnecting ? 'Connecting…' : 'Connect via MCP'}
                    </Button>
                  </form>
                </TabsContent>
              </Tabs>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-[#2a2a2a] bg-[#0c0c0c] px-4 py-3 text-sm text-zinc-500">
              Connection status stays visible here for inspection. Reconnect, disconnect, OAuth launch, and sync actions are restricted to workspace-admin sessions.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Channel Identities */}
      <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
        <CardHeader className="border-b border-[#1a1a1a] pb-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <CardTitle className="text-zinc-100 flex items-center gap-2">
              <Users strokeWidth={1.5} className="h-4 w-4 text-zinc-400" />
              Connected Users
            </CardTitle>
            <CardDescription className="text-zinc-500 mt-1">
              Users registered from connected messaging channels. Created automatically on first message.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Select value={channelFilter} onValueChange={(val) => setChannelFilter(val as typeof channelFilter)}>
              <SelectTrigger className="bg-[#0a0a0a] border-[#222] w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[#111] border-[#222] text-zinc-300">
                <SelectItem value="all">All channels</SelectItem>
                <SelectItem value="lark">Lark</SelectItem>
                <SelectItem value="slack">Slack</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadIdentities()}
              className="border-[#222] text-zinc-400 hover:text-zinc-200 hover:bg-[#1a1a1a]"
            >
              <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {identitiesLoading ? (
            <div className="flex flex-col gap-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center p-3 rounded-md bg-[#0a0a0a] border border-[#1a1a1a] h-[62px] gap-4">
                  <Skeleton className="h-4 w-12 shrink-0" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-24 ml-auto" />
                </div>
              ))}
            </div>
          ) : identities.length === 0 ? (
            <p className="text-sm text-zinc-500 italic p-3 rounded bg-[#0a0a0a] border border-dashed border-[#222]">
              {isSuperAdmin && !scopedCompanyId
                ? 'Enter a workspace ID above to view connected users.'
                : 'No users found. Users are registered automatically when they first message the bot.'}
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border border-[#1a1a1a]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#1a1a1a] bg-[#0a0a0a]">
                    <th className="px-4 py-2.5 text-left text-[11px] text-zinc-500 font-medium uppercase tracking-wide">Channel</th>
                    <th className="px-4 py-2.5 text-left text-[11px] text-zinc-500 font-medium uppercase tracking-wide">User</th>
                    <th className="px-4 py-2.5 text-left text-[11px] text-zinc-500 font-medium uppercase tracking-wide hidden md:table-cell">Email</th>
                    <th className="px-4 py-2.5 text-left text-[11px] text-zinc-500 font-medium uppercase tracking-wide hidden md:table-cell">AI Role</th>
                    <th className="px-4 py-2.5 text-left text-[11px] text-zinc-500 font-medium uppercase tracking-wide hidden xl:table-cell">Source Roles</th>
                    <th className="px-4 py-2.5 text-left text-[11px] text-zinc-500 font-medium uppercase tracking-wide hidden lg:table-cell">External ID</th>
                    <th className="px-4 py-2.5 text-left text-[11px] text-zinc-500 font-medium uppercase tracking-wide hidden lg:table-cell">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {identities.map((identity) => (
                    <tr
                      key={identity.id}
                      className="border-b border-[#0f0f0f] hover:bg-[#0d0d0d] transition-colors last:border-b-0"
                    >
                      <td className="px-4 py-3">
                        <Badge
                          variant="outline"
                          className="border-[#222] text-zinc-400 bg-transparent text-xs capitalize"
                        >
                          {identity.channel}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col">
                          <span className="text-zinc-200 font-medium text-sm">
                            {identity.displayName ?? 'Unknown'}
                          </span>
                          <span className="text-[11px] text-zinc-600 md:hidden">
                            {identity.email ?? identity.externalUserId}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-zinc-400 text-xs">{identity.email ?? '—'}</span>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-zinc-300 text-xs font-medium">{identity.aiRole}</span>
                      </td>
                      <td className="px-4 py-3 hidden xl:table-cell">
                        <span className="text-zinc-500 text-xs">
                          {identity.sourceRoles.length > 0 ? identity.sourceRoles.join(', ') : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <span className="text-zinc-500 font-mono text-xs">{identity.externalUserId}</span>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <span className="text-zinc-500 text-xs">
                          {new Date(identity.createdAt).toLocaleDateString()}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {identities.length > 0 ? (
            <p className="text-xs text-zinc-600 mt-3 text-right">
              {identities.length} user{identities.length !== 1 ? 's' : ''}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
};
