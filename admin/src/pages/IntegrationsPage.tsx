import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Link2, Unlink, RefreshCw, Users, Zap, Building2, ExternalLink, ShieldCheck, Database, CheckCircle2, AlertCircle, ArrowRight, MessageSquare, Share2, Clock, Mail } from 'lucide-react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { api } from '../lib/api';
import { toast } from '../components/ui/use-toast';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../lib/utils';
import { Separator } from '../components/ui/separator';
import { ScrollArea } from '../components/ui/scroll-area';
import { Textarea } from '../components/ui/textarea';

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
  source?: 'platform_env' | 'legacy_company_config' | 'manual_profile' | 'missing';
  activeProfile?: ZohoConnectionProfileSummary | null;
};

type ZohoConnectionProfileSummary = {
  id: string;
  profileName: string;
  environment: 'prod' | 'sandbox';
  connectionSource: 'oauth_authorized' | 'manual_token_set';
  status: string;
  isActive: boolean;
  connectedAt?: string;
  scopes: string[];
  clientId: string;
  redirectUri: string;
  accountsBaseUrl: string;
  apiBaseUrl: string;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  updatedAt: string;
};

type ZohoConnectionProfileForm = {
  profileName: string;
  environment: 'prod' | 'sandbox';
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  redirectUri: string;
  accountsBaseUrl: string;
  apiBaseUrl: string;
  scopes: string;
  metadataJson: string;
  setActive: boolean;
};

type GoogleWorkspaceStatus = {
  configured: boolean;
  connected: boolean;
  email?: string;
  name?: string;
  scopes?: string[];
  updatedAt?: string;
  source?: string;
  redirectUri?: string;
};

type GoogleAuthorizeUrlResult = {
  authorizeUrl: string;
  redirectUri: string;
  scopes: string[];
};

type ZohoAuthorizeUrlResult = {
  authorizeUrl: string;
  redirectUri: string;
  scopes: string[];
  environment: 'prod' | 'sandbox';
  source: 'platform_env' | 'legacy_company_config' | 'missing';
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
  source?: 'platform_env' | 'legacy_company_config' | 'missing';
};

type LarkAuthorizeUrlResult = {
  authorizeUrl: string;
  redirectUri: string;
  source: 'platform_env';
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

type LarkOperationalConfigStatus = {
  configured: boolean;
  defaultBaseAppToken?: string;
  defaultBaseTableId?: string;
  defaultBaseViewId?: string;
  defaultTasklistId?: string;
  defaultCalendarId?: string;
  defaultApprovalCode?: string;
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
  aiRoleSource: 'sync' | 'manual';
  syncedAiRole?: string;
  syncedFromLarkRole?: string;
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
  const [googleWorkspaceLoading, setGoogleWorkspaceLoading] = useState(true);
  const [larkWorkspaceConfigLoading, setLarkWorkspaceConfigLoading] = useState(true);
  const [larkOperationalConfigLoading, setLarkOperationalConfigLoading] = useState(true);
  const [larkSyncLoading, setLarkSyncLoading] = useState(true);
  const [vectorShareLoading, setVectorShareLoading] = useState(true);

  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [larkBinding, setLarkBinding] = useState<LarkBindingResult | null>(null);
  const [larkWorkspaceConfig, setLarkWorkspaceConfig] = useState<LarkWorkspaceConfigStatus | null>(null);
  const [larkOperationalConfig, setLarkOperationalConfig] = useState<LarkOperationalConfigStatus | null>(null);
  const [larkSyncStatus, setLarkSyncStatus] = useState<LarkSyncStatus | null>(null);
  const [oauthConfig, setOauthConfig] = useState<ZohoOAuthConfigStatus | null>(null);
  const [zohoProfiles, setZohoProfiles] = useState<ZohoConnectionProfileSummary[]>([]);
  const [googleWorkspace, setGoogleWorkspace] = useState<GoogleWorkspaceStatus | null>(null);
  const [identities, setIdentities] = useState<ChannelIdentity[]>([]);
  const [vectorShareRequests, setVectorShareRequests] = useState<VectorShareRequest[]>([]);
  const [channelFilter, setChannelFilter] = useState<'all' | 'lark' | 'slack' | 'whatsapp'>('all');

  const [larkLaunching, setLarkLaunching] = useState(false);
  const [larkDisconnecting, setLarkDisconnecting] = useState(false);
  const [larkOperationalSaving, setLarkOperationalSaving] = useState(false);
  const [larkSyncTriggering, setLarkSyncTriggering] = useState(false);
  const [vectorShareMutatingId, setVectorShareMutatingId] = useState<string | null>(null);

  const [restScopes, setRestScopes] = useState('ZohoCRM.modules.ALL,ZohoCRM.coql.READ,ZohoCRM.settings.fields.READ,ZohoCRM.settings.modules.READ,ZohoCRM.modules.notes.ALL,ZohoCRM.modules.attachments.ALL,ZohoBooks.settings.READ,ZohoBooks.settings.CREATE,ZohoBooks.accountants.READ,ZohoBooks.contacts.ALL,ZohoBooks.estimates.ALL,ZohoBooks.invoices.ALL,ZohoBooks.creditnotes.ALL,ZohoBooks.customerpayments.ALL,ZohoBooks.bills.ALL,ZohoBooks.salesorders.ALL,ZohoBooks.purchaseorders.ALL,ZohoBooks.vendorpayments.ALL,ZohoBooks.banking.ALL');
  const [restEnv, setRestEnv] = useState<'prod' | 'sandbox'>('prod');
  const [zohoProfileForm, setZohoProfileForm] = useState<ZohoConnectionProfileForm>({
    profileName: '',
    environment: 'prod',
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    accessToken: '',
    accessTokenExpiresAt: '',
    refreshTokenExpiresAt: '',
    redirectUri: '',
    accountsBaseUrl: '',
    apiBaseUrl: '',
    scopes: '',
    metadataJson: '{}',
    setActive: true,
  });
  const [editingZohoProfileId, setEditingZohoProfileId] = useState<string | null>(null);
  const [zohoProfilesLoading, setZohoProfilesLoading] = useState(true);
  const [zohoProfileSaving, setZohoProfileSaving] = useState(false);
  const [zohoProfileMutatingId, setZohoProfileMutatingId] = useState<string | null>(null);
  const [zohoDisconnecting, setZohoDisconnecting] = useState(false);
  const [oauthLaunching, setOauthLaunching] = useState(false);
  const [googleLaunching, setGoogleLaunching] = useState(false);
  const [googleDisconnecting, setGoogleDisconnecting] = useState(false);
  const [historicalSyncTriggering, setHistoricalSyncTriggering] = useState(false);
  const [larkDefaultsForm, setLarkDefaultsForm] = useState({
    defaultBaseAppToken: '',
    defaultBaseTableId: '',
    defaultBaseViewId: '',
    defaultTasklistId: '',
    defaultCalendarId: '',
    defaultApprovalCode: '',
  });

  const zohoRedirectUri = oauthConfig?.redirectUri || `${window.location.origin}/zoho/callback`;

  const resetZohoProfileForm = (profile?: ZohoConnectionProfileSummary | null) => {
    setEditingZohoProfileId(profile?.id ?? null);
    setZohoProfileForm({
      profileName: profile?.profileName ?? '',
      environment: profile?.environment ?? restEnv,
      clientId: profile?.clientId ?? oauthConfig?.clientId ?? '',
      clientSecret: '',
      refreshToken: '',
      accessToken: '',
      accessTokenExpiresAt: profile?.accessTokenExpiresAt ? profile.accessTokenExpiresAt.slice(0, 16) : '',
      refreshTokenExpiresAt: profile?.refreshTokenExpiresAt ? profile.refreshTokenExpiresAt.slice(0, 16) : '',
      redirectUri: profile?.redirectUri ?? zohoRedirectUri,
      accountsBaseUrl: profile?.accountsBaseUrl ?? oauthConfig?.accountsBaseUrl ?? '',
      apiBaseUrl: profile?.apiBaseUrl ?? oauthConfig?.apiBaseUrl ?? '',
      scopes: profile?.scopes?.join(',') ?? restScopes,
      metadataJson: '{}',
      setActive: profile?.isActive ?? true,
    });
  };

  const loadStatus = async (options?: { silent?: boolean }) => {
    if (!token) return;
    if (isSuperAdmin && !scopedCompanyId) {
      setOnboarding(null);
      setStatusLoading(false);
      return;
    }
    if (!options?.silent) setStatusLoading(true);
    try {
      const status = await api.get<OnboardingStatus>(`/api/admin/company/onboarding/status${buildQuery()}`, token);
      setOnboarding(status);
      setLarkBinding(status.larkBinding ?? null);
    } finally {
      setStatusLoading(false);
    }
  };

  const loadIdentities = async (options?: { silent?: boolean }) => {
    if (!token) return;
    if (isSuperAdmin && !scopedCompanyId) {
      setIdentities([]);
      setIdentitiesLoading(false);
      return;
    }
    if (!options?.silent) setIdentitiesLoading(true);
    try {
      const channelParam = channelFilter !== 'all' ? `channel=${channelFilter}` : '';
      const rows = await api.get<ChannelIdentity[]>(`/api/admin/company/channel-identities${buildQuery(channelParam)}`, token);
      setIdentities(rows);
    } finally {
      setIdentitiesLoading(false);
    }
  };

  const loadZohoOAuthConfig = async () => {
    if (!token || (isSuperAdmin && !scopedCompanyId)) { setOauthConfig(null); setOauthConfigLoading(false); return; }
    setOauthConfigLoading(true);
    try {
      const result = await api.get<ZohoOAuthConfigStatus>(`/api/admin/company/onboarding/zoho-oauth-config${buildQuery()}`, token);
      setOauthConfig(result);
    } catch { setOauthConfig({ configured: false }); } finally { setOauthConfigLoading(false); }
  };

  const loadZohoProfiles = async (options?: { silent?: boolean }) => {
    if (!token || (isSuperAdmin && !scopedCompanyId)) { setZohoProfiles([]); setZohoProfilesLoading(false); return; }
    if (!options?.silent) setZohoProfilesLoading(true);
    try {
      const result = await api.get<ZohoConnectionProfileSummary[]>(`/api/admin/company/onboarding/zoho-profiles${buildQuery()}`, token);
      setZohoProfiles(result);
    } catch {
      setZohoProfiles([]);
    } finally {
      setZohoProfilesLoading(false);
    }
  };

  const loadGoogleWorkspaceStatus = async () => {
    if (!token || (isSuperAdmin && !scopedCompanyId)) { setGoogleWorkspace(null); setGoogleWorkspaceLoading(false); return; }
    setGoogleWorkspaceLoading(true);
    try {
      const result = await api.get<GoogleWorkspaceStatus>(`/api/admin/company/onboarding/google-workspace-status${buildQuery()}`, token);
      setGoogleWorkspace(result);
    } catch {
      setGoogleWorkspace({ configured: false, connected: false });
    } finally {
      setGoogleWorkspaceLoading(false);
    }
  };

  const loadLarkWorkspaceConfig = async () => {
    if (!token || (isSuperAdmin && !scopedCompanyId)) { setLarkWorkspaceConfig(null); setLarkWorkspaceConfigLoading(false); return; }
    setLarkWorkspaceConfigLoading(true);
    try {
      const result = await api.get<LarkWorkspaceConfigStatus>(`/api/admin/company/onboarding/lark-workspace-config${buildQuery()}`, token);
      setLarkWorkspaceConfig(result);
    } catch { setLarkWorkspaceConfig({ configured: false }); } finally { setLarkWorkspaceConfigLoading(false); }
  };

  const loadLarkSyncStatus = async (options?: { silent?: boolean }) => {
    if (!token || (isSuperAdmin && !scopedCompanyId)) { setLarkSyncStatus(null); setLarkSyncLoading(false); return; }
    if (!options?.silent) setLarkSyncLoading(true);
    try {
      const result = await api.get<LarkSyncStatus>(`/api/admin/company/onboarding/lark-sync/status${buildQuery()}`, token);
      setLarkSyncStatus(result);
    } catch { setLarkSyncStatus({ hasRun: false }); } finally { setLarkSyncLoading(false); }
  };

  const loadLarkOperationalConfig = async () => {
    if (!token || (isSuperAdmin && !scopedCompanyId)) { setLarkOperationalConfig(null); setLarkOperationalConfigLoading(false); return; }
    setLarkOperationalConfigLoading(true);
    try {
      const result = await api.get<LarkOperationalConfigStatus>(`/api/admin/company/onboarding/lark-operational-config${buildQuery()}`, token);
      setLarkOperationalConfig(result);
      setLarkDefaultsForm({
        defaultBaseAppToken: result.defaultBaseAppToken ?? '',
        defaultBaseTableId: result.defaultBaseTableId ?? '',
        defaultBaseViewId: result.defaultBaseViewId ?? '',
        defaultTasklistId: result.defaultTasklistId ?? '',
        defaultCalendarId: result.defaultCalendarId ?? '',
        defaultApprovalCode: result.defaultApprovalCode ?? '',
      });
    } finally { setLarkOperationalConfigLoading(false); }
  };

  const loadVectorShareRequests = async () => {
    if (!token || (isSuperAdmin && !scopedCompanyId)) { setVectorShareRequests([]); setVectorShareLoading(false); return; }
    setVectorShareLoading(true);
    try {
      const result = await api.get<VectorShareRequest[]>(`/api/admin/company/vector-share-requests${buildQuery()}`, token);
      setVectorShareRequests(result);
    } finally { setVectorShareLoading(false); }
  };

  useEffect(() => {
    void loadStatus(); void loadIdentities(); void loadZohoOAuthConfig(); void loadGoogleWorkspaceStatus();
    void loadZohoProfiles(); void loadLarkWorkspaceConfig(); void loadLarkOperationalConfig();
    void loadLarkSyncStatus(); void loadVectorShareRequests();
  }, [token, scopedCompanyId, isSuperAdmin]);

  useEffect(() => {
    resetZohoProfileForm(oauthConfig?.activeProfile ?? null);
  }, [oauthConfig?.activeProfile?.id, oauthConfig?.clientId, oauthConfig?.redirectUri, oauthConfig?.accountsBaseUrl, oauthConfig?.apiBaseUrl, restEnv, restScopes]);

  useEffect(() => { void loadIdentities(); }, [channelFilter]);

  useEffect(() => {
    if (!onboarding?.historicalSync) return;
    if (!['queued', 'running'].includes(onboarding.historicalSync.status)) return;
    const interval = window.setInterval(() => { void loadStatus({ silent: true }); }, 5000);
    return () => window.clearInterval(interval);
  }, [onboarding?.historicalSync?.status]);

  useEffect(() => {
    if (!larkSyncStatus?.status) return;
    if (!['queued', 'running'].includes(larkSyncStatus.status)) return;
    const interval = window.setInterval(() => { void loadLarkSyncStatus({ silent: true }); void loadIdentities({ silent: true }); }, 5000);
    return () => window.clearInterval(interval);
  }, [larkSyncStatus?.status]);

  const triggerLarkUserSync = async () => {
    if (!token) return; setLarkSyncTriggering(true);
    try {
      const result = await api.post<{ runId: string; status: string; queued: boolean }>('/api/admin/company/onboarding/lark-sync', { companyId: scopedCompanyId || undefined }, token);
      toast({ title: result.queued ? 'Lark user sync started' : 'Lark user sync already running', variant: 'success' });
      void loadLarkSyncStatus();
    } finally { setLarkSyncTriggering(false); }
  };

  const saveLarkOperationalConfig = async () => {
    if (!token) return; setLarkOperationalSaving(true);
    try {
      await api.post('/api/admin/company/onboarding/lark-operational-config', { companyId: scopedCompanyId || undefined, ...larkDefaultsForm }, token);
      toast({ title: 'Lark operational defaults saved', variant: 'success' });
      await loadLarkOperationalConfig();
    } finally { setLarkOperationalSaving(false); }
  };

  const launchLarkOauth = async () => {
    if (isSuperAdmin && !scopedCompanyId) { toast({ title: 'Workspace required', variant: 'destructive' }); return; }
    if (!larkWorkspaceConfig?.configured) { toast({ title: 'Lark is not configured', variant: 'destructive' }); return; }
    setLarkLaunching(true);
    try {
      const query = new URLSearchParams(); if (scopedCompanyId) query.set('companyId', scopedCompanyId);
      const result = await api.get<LarkAuthorizeUrlResult>(`/api/admin/company/onboarding/lark-authorize-url?${query.toString()}`, token || undefined);
      window.location.assign(result.authorizeUrl);
    } catch { setLarkLaunching(false); }
  };

  const disconnectLark = async () => {
    if (!token || !window.confirm('Disconnect this Lark workspace?')) return; setLarkDisconnecting(true);
    try {
      await api.post('/api/admin/company/onboarding/lark-disconnect', { companyId: scopedCompanyId || undefined }, token);
      toast({ title: 'Lark disconnected', variant: 'success' });
      void loadStatus(); void loadLarkSyncStatus();
    } finally { setLarkDisconnecting(false); }
  };

  const disconnectZoho = async () => {
    if (!token || !window.confirm('Disconnect Zoho?')) return; setZohoDisconnecting(true);
    try {
      await api.post('/api/admin/company/onboarding/disconnect', { companyId: scopedCompanyId || undefined }, token);
      toast({ title: 'Zoho disconnected', variant: 'success' });
      void loadStatus(); void loadZohoOAuthConfig(); void loadZohoProfiles();
    } finally { setZohoDisconnecting(false); }
  };

  const launchGoogleOauth = async () => {
    if (isSuperAdmin && !scopedCompanyId) { toast({ title: 'Workspace required', variant: 'destructive' }); return; }
    if (!googleWorkspace?.configured) { toast({ title: 'Google OAuth is not configured', variant: 'destructive' }); return; }
    setGoogleLaunching(true);
    try {
      const query = new URLSearchParams();
      if (scopedCompanyId) query.set('companyId', scopedCompanyId);
      const result = await api.get<GoogleAuthorizeUrlResult>(`/api/admin/company/onboarding/google-authorize-url?${query.toString()}`, token || undefined);
      window.location.assign(result.authorizeUrl);
    } catch {
      setGoogleLaunching(false);
    }
  };

  const disconnectGoogleWorkspace = async () => {
    if (!token || !window.confirm('Disconnect Google Workspace for this company?')) return;
    setGoogleDisconnecting(true);
    try {
      const query = new URLSearchParams();
      if (scopedCompanyId) query.set('companyId', scopedCompanyId);
      await api.post(`/api/admin/company/onboarding/google-disconnect${query.toString() ? `?${query.toString()}` : ''}`, {}, token);
      toast({ title: 'Google Workspace disconnected', variant: 'success' });
      void loadGoogleWorkspaceStatus();
    } finally {
      setGoogleDisconnecting(false);
    }
  };

  const triggerHistoricalSync = async () => {
    if (!token) return; setHistoricalSyncTriggering(true);
    try {
      await api.post('/api/admin/company/onboarding/sync/historical', { companyId: scopedCompanyId || undefined }, token);
      toast({ title: 'Historical sync queued', variant: 'success' });
      void loadStatus();
    } finally { setHistoricalSyncTriggering(false); }
  };

  const approveVectorShareRequest = async (requestId: string) => {
    if (!token) return; setVectorShareMutatingId(requestId);
    try {
      await api.post(`/api/admin/company/vector-share-requests/${requestId}/approve`, { companyId: scopedCompanyId || undefined }, token);
      toast({ title: 'Share request approved', variant: 'success' });
      void loadVectorShareRequests(); void loadStatus();
    } finally { setVectorShareMutatingId(null); }
  };

  const rejectVectorShareRequest = async (requestId: string) => {
    if (!token) return; setVectorShareMutatingId(requestId);
    try {
      await api.post(`/api/admin/company/vector-share-requests/${requestId}/reject`, { companyId: scopedCompanyId || undefined }, token);
      toast({ title: 'Share request rejected', variant: 'success' });
      void loadVectorShareRequests();
    } finally { setVectorShareMutatingId(null); }
  };

  const launchZohoOauth = async () => {
    if (isSuperAdmin && !scopedCompanyId) { toast({ title: 'Workspace required', variant: 'destructive' }); return; }
    if (!oauthConfig?.configured) { toast({ title: 'Zoho OAuth is not configured', variant: 'destructive' }); return; }
    setOauthLaunching(true);
    try {
      const query = new URLSearchParams(); if (scopedCompanyId) query.set('companyId', scopedCompanyId);
      query.set('scopes', restScopes); query.set('environment', restEnv);
      const result = await api.get<ZohoAuthorizeUrlResult>(`/api/admin/company/onboarding/zoho-authorize-url?${query.toString()}`, token || undefined);
      window.location.assign(result.authorizeUrl);
    } catch { setOauthLaunching(false); }
  };

  const saveZohoProfile = async () => {
    if (!token) return;
    setZohoProfileSaving(true);
    try {
      const payload = {
        companyId: scopedCompanyId || undefined,
        profileName: zohoProfileForm.profileName.trim(),
        environment: zohoProfileForm.environment,
        clientId: zohoProfileForm.clientId.trim(),
        clientSecret: zohoProfileForm.clientSecret.trim(),
        refreshToken: zohoProfileForm.refreshToken.trim(),
        accessToken: zohoProfileForm.accessToken.trim() || undefined,
        accessTokenExpiresAt: zohoProfileForm.accessTokenExpiresAt || undefined,
        refreshTokenExpiresAt: zohoProfileForm.refreshTokenExpiresAt || undefined,
        redirectUri: zohoProfileForm.redirectUri.trim(),
        accountsBaseUrl: zohoProfileForm.accountsBaseUrl.trim() || undefined,
        apiBaseUrl: zohoProfileForm.apiBaseUrl.trim() || undefined,
        scopes: zohoProfileForm.scopes.split(',').map((value) => value.trim()).filter(Boolean),
        metadata: zohoProfileForm.metadataJson.trim() ? JSON.parse(zohoProfileForm.metadataJson) : {},
        setActive: zohoProfileForm.setActive,
      };
      if (editingZohoProfileId) {
        await api.put(`/api/admin/company/onboarding/zoho-profiles/${editingZohoProfileId}`, payload, token);
        toast({ title: 'Zoho profile updated', variant: 'success' });
      } else {
        await api.post(`/api/admin/company/onboarding/zoho-profiles`, payload, token);
        toast({ title: 'Zoho profile created', variant: 'success' });
      }
      await Promise.all([loadZohoProfiles(), loadZohoOAuthConfig(), loadStatus({ silent: true })]);
      resetZohoProfileForm(null);
    } catch (error) {
      toast({
        title: 'Zoho profile save failed',
        description: error instanceof Error ? error.message : 'Invalid Zoho profile payload',
        variant: 'destructive',
      });
    } finally {
      setZohoProfileSaving(false);
    }
  };

  const activateZohoProfile = async (profileId: string) => {
    if (!token) return;
    setZohoProfileMutatingId(profileId);
    try {
      await api.post(`/api/admin/company/onboarding/zoho-profiles/${profileId}/activate`, { companyId: scopedCompanyId || undefined }, token);
      toast({ title: 'Zoho profile activated', variant: 'success' });
      await Promise.all([loadZohoProfiles(), loadZohoOAuthConfig(), loadStatus({ silent: true })]);
    } finally {
      setZohoProfileMutatingId(null);
    }
  };

  const disableZohoProfile = async (profileId: string) => {
    if (!token) return;
    setZohoProfileMutatingId(profileId);
    try {
      await api.post(`/api/admin/company/onboarding/zoho-profiles/${profileId}/disable`, { companyId: scopedCompanyId || undefined }, token);
      toast({ title: 'Zoho profile disabled', variant: 'success' });
      await Promise.all([loadZohoProfiles(), loadZohoOAuthConfig(), loadStatus({ silent: true })]);
    } finally {
      setZohoProfileMutatingId(null);
    }
  };

  const zohoConnected = !!onboarding?.connection && onboarding.connection.status !== 'disconnected';
  const googleConnected = !!googleWorkspace?.connected;

  if (requiresWorkspaceSelection) {
    return (
      <div className="flex flex-col gap-10 max-w-5xl animate-in fade-in duration-700">
        <Card className="bg-card border-border/50 shadow-md overflow-hidden">
          <CardHeader className="bg-secondary/5 border-b border-border/50 pb-6">
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" />
              Workspace Selection Required
            </CardTitle>
            <CardDescription>
              Enter a workspace UUID below to inspect its operational integration status and diagnostics.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-8">
            <div className="flex items-center gap-4 max-w-xl">
              <Input
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                placeholder="Paste workspace UUID (e.g. 550e8400-e29b...)"
                className="h-11 bg-secondary/20 border-border/50 font-mono text-xs"
              />
              <Button onClick={() => void loadStatus()} className="h-11 px-8 font-bold uppercase tracking-widest text-xs">
                Inspect
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10 max-w-5xl animate-in fade-in duration-700 pb-20">
      {isSuperAdmin && (
        <div className="flex items-center justify-between p-4 rounded-xl border border-primary/20 bg-primary/5">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <div className="flex flex-col">
              <span className="text-[10px] font-bold uppercase tracking-widest text-primary leading-none mb-1">Administrative Scope</span>
              <span className="text-xs font-mono font-bold text-foreground">{workspaceId}</span>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setWorkspaceId('')} className="text-[10px] font-bold uppercase tracking-widest text-primary hover:bg-primary/10">
            Change Scope
          </Button>
        </div>
      )}

      {/* Integration Grid */}
      <div className="grid gap-8">
        {/* Lark Section */}
        <section className="space-y-6">
          <div className="flex items-center gap-3 ml-1">
            <div className="h-10 w-10 rounded-xl bg-[#00d2be]/10 border border-[#00d2be]/20 flex items-center justify-center">
              <MessageSquare className="h-5 w-5 text-[#00d2be]" />
            </div>
            <div className="space-y-0.5">
              <h2 className="text-lg font-bold">Lark Workspace</h2>
              <p className="text-xs text-muted-foreground uppercase font-medium tracking-tighter">Unified Communication & Identity Provider</p>
            </div>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <Card className={cn("bg-card border-border/50 shadow-md overflow-hidden transition-all", larkBinding?.isActive ? "border-emerald-500/20" : "")}>
              <CardHeader className="bg-secondary/5 border-b border-border/50 py-4 px-6 flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Connection Status</CardTitle>
                <Badge variant={larkBinding?.isActive ? "secondary" : "outline"} className={cn(
                  "text-[9px] h-5 font-bold uppercase",
                  larkBinding?.isActive ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : "text-muted-foreground"
                )}>
                  {larkBinding?.isActive ? 'Linked & Active' : 'Disconnected'}
                </Badge>
              </CardHeader>
              <CardContent className="p-6 space-y-6">
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-tighter leading-none">Tenant Key</span>
                      <div className="text-xs font-mono truncate">{larkBinding?.larkTenantKey || '—'}</div>
                    </div>
                    <div className="space-y-1">
                      <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-tighter leading-none">Auth Source</span>
                      <div className="text-xs uppercase font-bold">{larkWorkspaceConfig?.source || 'unknown'}</div>
                    </div>
                  </div>
                  {canManageWorkspaceIntegrations && (
                    <div className="pt-2 flex flex-col gap-3">
                      <Button onClick={() => void launchLarkOauth()} disabled={larkLaunching} className="w-full bg-foreground text-background font-bold uppercase text-[10px] tracking-widest h-9">
                        {larkLaunching ? 'Connecting...' : (larkBinding?.isActive ? 'Reconnect Lark' : 'Connect Lark')}
                      </Button>
                      {larkBinding?.isActive && (
                        <Button variant="ghost" onClick={() => void disconnectLark()} disabled={larkDisconnecting} className="text-destructive hover:bg-destructive/10 text-[10px] font-bold uppercase tracking-widest h-9">
                          Disconnect Integration
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card border-border/50 shadow-md overflow-hidden">
              <CardHeader className="bg-secondary/5 border-b border-border/50 py-4 px-6">
                <CardTitle className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Directory Sync</CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="grid grid-cols-2 gap-y-6">
                  <div className="space-y-1">
                    <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-tighter leading-none">Synced Users</span>
                    <div className="text-2xl font-bold">{larkSyncStatus?.syncedCount || 0}</div>
                  </div>
                  <div className="space-y-1">
                    <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-tighter leading-none">Last Run</span>
                    <div className="text-xs font-medium">{larkSyncStatus?.updatedAt ? new Date(larkSyncStatus.updatedAt).toLocaleDateString() : 'Never'}</div>
                  </div>
                  <div className="col-span-2">
                    <Button variant="outline" onClick={() => void triggerLarkUserSync()} disabled={larkSyncTriggering || !larkBinding?.isActive} className="w-full h-9 text-[10px] font-bold uppercase tracking-widest border-border/50">
                      <RefreshCw className={cn("h-3 w-3 mr-2", larkSyncTriggering && "animate-spin")} />
                      Force Identity Sync
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Google Workspace Section */}
        <section className="space-y-6">
          <div className="flex items-center gap-3 ml-1">
            <div className="h-10 w-10 rounded-xl bg-[#4285f4]/10 border border-[#4285f4]/20 flex items-center justify-center">
              <Mail className="h-5 w-5 text-[#4285f4]" />
            </div>
            <div className="space-y-0.5">
              <h2 className="text-lg font-bold">Google Workspace</h2>
              <p className="text-xs text-muted-foreground uppercase font-medium tracking-tighter">Company Mailbox & Drive For Finance Automation</p>
            </div>
          </div>

          <div className="grid gap-6 md:grid-cols-[1fr_320px]">
            <Card className={cn("bg-card border-border/50 shadow-md overflow-hidden", googleConnected ? "border-emerald-500/20" : "")}>
              <CardHeader className="bg-secondary/5 border-b border-border/50 py-4 px-6 flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Connection Status</CardTitle>
                <Badge variant={googleConnected ? "secondary" : "outline"} className={cn(
                  "text-[9px] h-5 font-bold uppercase",
                  googleConnected ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : "text-muted-foreground"
                )}>
                  {googleConnected ? 'Connected' : 'Disconnected'}
                </Badge>
              </CardHeader>
              <CardContent className="p-6 space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-tighter leading-none">Connected Email</span>
                    <div className="text-xs font-medium break-all">{googleWorkspace?.email || '—'}</div>
                  </div>
                  <div className="space-y-1">
                    <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-tighter leading-none">Updated</span>
                    <div className="text-xs font-medium">{googleWorkspace?.updatedAt ? new Date(googleWorkspace.updatedAt).toLocaleString() : '—'}</div>
                  </div>
                  <div className="col-span-2 space-y-1">
                    <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-tighter leading-none">Scopes</span>
                    <div className="text-[10px] font-mono text-muted-foreground break-all">
                      {googleWorkspace?.scopes && googleWorkspace.scopes.length > 0 ? googleWorkspace.scopes.join(', ') : 'No scopes granted yet'}
                    </div>
                  </div>
                </div>
                {canManageWorkspaceIntegrations && (
                  <div className="pt-2 flex flex-col gap-3">
                    <Button onClick={() => void launchGoogleOauth()} disabled={googleLaunching || googleWorkspaceLoading} className="w-full bg-foreground text-background font-bold uppercase text-[10px] tracking-widest h-9">
                      {googleLaunching ? 'Connecting...' : (googleConnected ? 'Reconnect Google' : 'Connect Google')}
                    </Button>
                    {googleConnected && (
                      <Button variant="ghost" onClick={() => void disconnectGoogleWorkspace()} disabled={googleDisconnecting} className="text-destructive hover:bg-destructive/10 text-[10px] font-bold uppercase tracking-widest h-9">
                        Disconnect Integration
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="bg-card border-border/50 shadow-md overflow-hidden">
              <CardHeader className="bg-secondary/5 border-b border-border/50 py-4 px-6">
                <CardTitle className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Usage Model</CardTitle>
              </CardHeader>
              <CardContent className="p-6 space-y-4">
                <div className="space-y-2 text-xs text-muted-foreground leading-relaxed">
                  <p>Gmail and Drive are connected once at the company level and reused by Vercel finance workflows.</p>
                  <p>This is the preferred path for shared collections, reminders, statements, proofs, and reconciliation folders.</p>
                </div>
                <div className="rounded-lg border border-border/50 bg-secondary/10 p-3 text-[10px] font-mono text-muted-foreground break-all">
                  Redirect URI: {googleWorkspace?.redirectUri || '—'}
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Zoho Section */}
        <section className="space-y-6">
          <div className="flex items-center gap-3 ml-1">
            <div className="h-10 w-10 rounded-xl bg-[#f37021]/10 border border-[#f37021]/20 flex items-center justify-center">
              <Database className="h-5 w-5 text-[#f37021]" />
            </div>
            <div className="space-y-0.5">
              <h2 className="text-lg font-bold">Zoho CRM</h2>
              <p className="text-xs text-muted-foreground uppercase font-medium tracking-tighter">Enterprise Data & Retrieval Memory</p>
            </div>
          </div>

          <div className="grid gap-6 md:grid-cols-[1.1fr_0.9fr]">
            <Card className={cn("bg-card border-border/50 shadow-md overflow-hidden", zohoConnected ? "border-emerald-500/20" : "")}>
              <CardHeader className="bg-secondary/5 border-b border-border/50 py-4 px-6 flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Retrieval Health</CardTitle>
                <Badge variant={zohoConnected ? "secondary" : "outline"} className={cn(
                  "text-[9px] h-5 font-bold uppercase",
                  zohoConnected ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : "text-muted-foreground"
                )}>
                  {zohoConnected ? 'Engine Ready' : 'Disconnected'}
                </Badge>
              </CardHeader>
              <CardContent className="p-0">
                <div className="p-6 grid grid-cols-3 gap-4 border-b border-border/50">
                  <div className="space-y-1">
                    <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-tighter leading-none">Sync Status</span>
                    <div className="text-xs font-bold uppercase">{onboarding?.historicalSync?.status || 'idle'}</div>
                  </div>
                  <div className="space-y-1">
                    <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-tighter leading-none">Index Size</span>
                    <div className="text-xs font-bold tabular-nums">{onboarding?.vectorIndex?.indexedCount?.toLocaleString() || 0} Docs</div>
                  </div>
                  <div className="space-y-1">
                    <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-tighter leading-none">Index Health</span>
                    <div className={cn("text-xs font-bold uppercase", onboarding?.vectorIndex?.healthy ? "text-emerald-500" : "text-red-500")}>
                      {onboarding?.vectorIndex?.healthy ? 'Healthy' : 'Degraded'}
                    </div>
                  </div>
                </div>
                <div className="p-6 bg-secondary/10 space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-widest">Historical Sync Progress</span>
                      <span className="text-[10px] font-bold tabular-nums">{onboarding?.historicalSync?.progressPercent || 0}%</span>
                    </div>
                    <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden border border-border/50">
                      <div className="h-full bg-emerald-500 transition-all duration-1000" style={{ width: `${onboarding?.historicalSync?.progressPercent || 0}%` }} />
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <Button onClick={() => void triggerHistoricalSync()} disabled={historicalSyncTriggering || !zohoConnected} size="sm" className="flex-1 h-8 text-[9px] font-bold uppercase tracking-widest">
                      <Zap className="h-3 w-3 mr-2" /> Resume / Re-sync
                    </Button>
                    {zohoConnected && canManageWorkspaceIntegrations && (
                      <Button variant="outline" onClick={() => void disconnectZoho()} disabled={zohoDisconnecting} size="sm" className="h-8 text-[9px] font-bold uppercase tracking-widest border-border/50">
                        <Unlink className="h-3 w-3 mr-2" /> Disconnect
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="space-y-6">
              <Card className="bg-card border-border/50 shadow-md overflow-hidden">
                <CardHeader className="bg-secondary/5 border-b border-border/50 py-4 px-6 flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Connection Center</CardTitle>
                    <CardDescription className="mt-1 text-xs">
                      OAuth and manual encrypted token-set profiles both feed the same active runtime connection.
                    </CardDescription>
                  </div>
                  <Badge variant="outline" className="text-[9px] h-5 font-bold uppercase border-border/50">
                    {oauthConfig?.activeProfile?.connectionSource === 'manual_token_set'
                      ? 'Manual Active'
                      : zohoConnected
                        ? 'OAuth Active'
                        : 'No Active Profile'}
                  </Badge>
                </CardHeader>
                <CardContent className="p-6 space-y-5">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold uppercase text-muted-foreground tracking-widest ml-1">OAuth Environment</label>
                      <Select value={restEnv} onValueChange={(val) => setRestEnv(val as 'prod' | 'sandbox')}>
                        <SelectTrigger className="bg-secondary/20 border-border/50 h-9 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="prod">Production</SelectItem>
                          <SelectItem value="sandbox">Sandbox</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold uppercase text-muted-foreground tracking-widest ml-1">Platform Source</label>
                      <div className="h-9 px-3 rounded-md border border-border/50 bg-secondary/10 text-xs flex items-center">
                        {oauthConfig?.source || 'missing'}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold uppercase text-muted-foreground tracking-widest ml-1">Scopes Policy</label>
                    <div className="p-3 rounded-lg bg-[#050505] border border-border/50 text-[10px] font-mono text-muted-foreground break-all leading-relaxed">
                      {restScopes}
                    </div>
                  </div>

                  {canManageWorkspaceIntegrations && (
                    <div className="grid gap-3 md:grid-cols-2">
                      <Button onClick={() => void launchZohoOauth()} disabled={oauthLaunching || !oauthConfig?.configured} className="bg-[#f37021] hover:bg-[#f37021]/90 text-white font-bold uppercase text-[10px] tracking-widest h-10 shadow-lg shadow-[#f37021]/10">
                        {oauthLaunching ? 'Authorizing...' : 'Connect via OAuth'}
                      </Button>
                      <Button variant="outline" onClick={() => resetZohoProfileForm(null)} className="h-10 text-[10px] font-bold uppercase tracking-widest border-border/50">
                        Add Manual Profile
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="bg-card border-border/50 shadow-md overflow-hidden">
                <CardHeader className="bg-secondary/5 border-b border-border/50 py-4 px-6">
                  <CardTitle className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
                    {editingZohoProfileId ? 'Edit Manual Token Set' : 'Manual Token Set'}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-6 space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <Input
                      value={zohoProfileForm.profileName}
                      onChange={(event) => setZohoProfileForm((prev) => ({ ...prev, profileName: event.target.value }))}
                      placeholder="Profile name"
                    />
                    <Select
                      value={zohoProfileForm.environment}
                      onValueChange={(value) =>
                        setZohoProfileForm((prev) => ({ ...prev, environment: value as 'prod' | 'sandbox' }))
                      }
                    >
                      <SelectTrigger><SelectValue placeholder="Environment" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="prod">Production</SelectItem>
                        <SelectItem value="sandbox">Sandbox</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      value={zohoProfileForm.clientId}
                      onChange={(event) => setZohoProfileForm((prev) => ({ ...prev, clientId: event.target.value }))}
                      placeholder="Client ID"
                    />
                    <Input
                      value={zohoProfileForm.clientSecret}
                      onChange={(event) => setZohoProfileForm((prev) => ({ ...prev, clientSecret: event.target.value }))}
                      placeholder={editingZohoProfileId ? 'Client secret (leave blank to keep)' : 'Client secret'}
                    />
                    <Input
                      value={zohoProfileForm.refreshToken}
                      onChange={(event) => setZohoProfileForm((prev) => ({ ...prev, refreshToken: event.target.value }))}
                      placeholder={editingZohoProfileId ? 'Refresh token (leave blank to keep)' : 'Refresh token'}
                    />
                    <Input
                      value={zohoProfileForm.accessToken}
                      onChange={(event) => setZohoProfileForm((prev) => ({ ...prev, accessToken: event.target.value }))}
                      placeholder="Access token (optional)"
                    />
                    <Input
                      type="datetime-local"
                      value={zohoProfileForm.accessTokenExpiresAt}
                      onChange={(event) => setZohoProfileForm((prev) => ({ ...prev, accessTokenExpiresAt: event.target.value }))}
                    />
                    <Input
                      type="datetime-local"
                      value={zohoProfileForm.refreshTokenExpiresAt}
                      onChange={(event) => setZohoProfileForm((prev) => ({ ...prev, refreshTokenExpiresAt: event.target.value }))}
                    />
                    <Input
                      value={zohoProfileForm.redirectUri}
                      onChange={(event) => setZohoProfileForm((prev) => ({ ...prev, redirectUri: event.target.value }))}
                      placeholder="Redirect URI"
                    />
                    <Input
                      value={zohoProfileForm.accountsBaseUrl}
                      onChange={(event) => setZohoProfileForm((prev) => ({ ...prev, accountsBaseUrl: event.target.value }))}
                      placeholder="Accounts base URL"
                    />
                    <Input
                      value={zohoProfileForm.apiBaseUrl}
                      onChange={(event) => setZohoProfileForm((prev) => ({ ...prev, apiBaseUrl: event.target.value }))}
                      placeholder="API base URL"
                    />
                    <Input
                      value={zohoProfileForm.scopes}
                      onChange={(event) => setZohoProfileForm((prev) => ({ ...prev, scopes: event.target.value }))}
                      placeholder="Comma-separated scopes"
                    />
                  </div>
                  <Textarea
                    rows={4}
                    value={zohoProfileForm.metadataJson}
                    onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setZohoProfileForm((prev) => ({ ...prev, metadataJson: event.target.value }))}
                    placeholder='Optional metadata JSON, e.g. {"booksOrgId":"123"}'
                    className="font-mono text-xs"
                  />
                  <div className="flex items-center justify-between gap-3">
                    <Button
                      variant={zohoProfileForm.setActive ? 'default' : 'outline'}
                      size="sm"
                      className="h-8 text-[10px] font-bold uppercase tracking-widest"
                      onClick={() => setZohoProfileForm((prev) => ({ ...prev, setActive: !prev.setActive }))}
                    >
                      {zohoProfileForm.setActive ? 'Will Set Active' : 'Save Inactive'}
                    </Button>
                    <div className="flex gap-2">
                      {editingZohoProfileId && (
                        <Button variant="ghost" size="sm" className="h-8 text-[10px] font-bold uppercase tracking-widest" onClick={() => resetZohoProfileForm(null)}>
                          Cancel Edit
                        </Button>
                      )}
                      <Button onClick={() => void saveZohoProfile()} disabled={zohoProfileSaving} size="sm" className="h-8 text-[10px] font-bold uppercase tracking-widest">
                        {zohoProfileSaving ? 'Saving...' : editingZohoProfileId ? 'Update Profile' : 'Create Profile'}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card border-border/50 shadow-md overflow-hidden">
                <CardHeader className="bg-secondary/5 border-b border-border/50 py-4 px-6 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Saved Profiles</CardTitle>
                  <Button variant="ghost" size="sm" onClick={() => void loadZohoProfiles()} className="text-[10px] font-bold uppercase tracking-widest h-7">
                    <RefreshCw className={cn("h-3 w-3 mr-2", zohoProfilesLoading && "animate-spin")} /> Refresh
                  </Button>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y divide-border/50">
                    {zohoProfiles.length === 0 ? (
                      <div className="p-6 text-xs text-muted-foreground">No Zoho profiles saved yet.</div>
                    ) : (
                      zohoProfiles.map((profile) => (
                        <div key={profile.id} className="p-4 space-y-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-semibold">{profile.profileName}</span>
                                <Badge variant={profile.isActive ? "secondary" : "outline"} className="text-[9px] h-5 uppercase">
                                  {profile.isActive ? 'Active' : profile.status}
                                </Badge>
                                <Badge variant="outline" className="text-[9px] h-5 uppercase border-border/50">
                                  {profile.connectionSource === 'manual_token_set' ? 'Manual' : 'OAuth'}
                                </Badge>
                              </div>
                              <div className="text-[10px] font-mono text-muted-foreground break-all">
                                {profile.environment} · {profile.clientId} · {profile.apiBaseUrl}
                              </div>
                            </div>
                            <div className="flex gap-2 shrink-0">
                              <Button variant="outline" size="sm" className="h-8 text-[10px] font-bold uppercase tracking-widest border-border/50" onClick={() => resetZohoProfileForm(profile)}>
                                Edit
                              </Button>
                              {!profile.isActive && (
                                <Button size="sm" className="h-8 text-[10px] font-bold uppercase tracking-widest" disabled={zohoProfileMutatingId === profile.id} onClick={() => void activateZohoProfile(profile.id)}>
                                  Activate
                                </Button>
                              )}
                              <Button variant="ghost" size="sm" className="h-8 text-[10px] font-bold uppercase tracking-widest text-destructive hover:bg-destructive/10" disabled={zohoProfileMutatingId === profile.id} onClick={() => void disableZohoProfile(profile.id)}>
                                Disable
                              </Button>
                            </div>
                          </div>
                          <div className="text-[10px] text-muted-foreground leading-relaxed">
                            Scopes: {profile.scopes.length ? profile.scopes.join(', ') : '—'}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        {/* Vector Share Requests */}
        <section className="space-y-6">
          <div className="flex items-center gap-3 ml-1">
            <div className="h-10 w-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Share2 className="h-5 w-5 text-primary" />
            </div>
            <div className="space-y-0.5">
              <h2 className="text-lg font-bold">Memory Promotion</h2>
              <p className="text-xs text-muted-foreground uppercase font-medium tracking-tighter">Share local intelligence with company index</p>
            </div>
          </div>

          <Card className="bg-card border-border/50 shadow-md overflow-hidden">
            <CardHeader className="bg-secondary/5 border-b border-border/50 py-4 px-6 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Pending Promotion Requests</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => void loadVectorShareRequests()} className="text-[10px] font-bold uppercase tracking-widest h-7">
                <RefreshCw className={cn("h-3 w-3 mr-2", vectorShareLoading && "animate-spin")} /> Refresh
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="max-h-[400px]">
                <div className="divide-y divide-border/50">
                  {vectorShareRequests.length === 0 ? (
                    <div className="p-12 text-center text-sm text-muted-foreground">
                      No memory promotion requests currently active.
                    </div>
                  ) : (
                    vectorShareRequests.map(req => (
                      <div key={req.id} className="p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 hover:bg-secondary/10 transition-colors">
                        <div className="space-y-2 min-w-0">
                          <div className="flex items-center gap-3">
                            <span className="text-sm font-bold text-foreground truncate max-w-[240px]">Conversation {req.conversationKey.slice(-8)}</span>
                            <Badge variant="outline" className="text-[9px] h-4 font-mono uppercase border-border/50">{req.status}</Badge>
                          </div>
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-medium">
                            <Users className="h-3 w-3" />
                            <span>Requester: {req.requesterUserId.slice(0, 8)}...</span>
                            <span>·</span>
                            <Clock className="h-3 w-3" />
                            <span>{new Date(req.createdAt).toLocaleString()}</span>
                          </div>
                          {req.reason && <p className="text-xs text-muted-foreground italic leading-relaxed">"{req.reason}"</p>}
                        </div>
                        {req.status === 'pending' && canManageWorkspaceIntegrations && (
                          <div className="flex gap-2 shrink-0">
                            <Button size="sm" onClick={() => approveVectorShareRequest(req.id)} disabled={!!vectorShareMutatingId} className="h-8 px-4 text-[10px] font-bold uppercase tracking-widest bg-emerald-600 hover:bg-emerald-700 text-white">Approve</Button>
                            <Button size="sm" variant="outline" onClick={() => rejectVectorShareRequest(req.id)} disabled={!!vectorShareMutatingId} className="h-8 px-4 text-[10px] font-bold uppercase tracking-widest border-border/50">Reject</Button>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
};
