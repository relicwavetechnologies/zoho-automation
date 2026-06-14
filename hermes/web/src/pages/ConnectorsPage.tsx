import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  Building2,
  CheckCircle2,
  Clock3,
  KeyRound,
  Link2,
  Mail,
  MessageSquare,
  RefreshCw,
  Save,
  ShieldCheck,
  Unplug,
  X,
} from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { usePageHeader } from "@/contexts/usePageHeader";
import { api } from "@/lib/api";
import type {
  CompanyConnectorCredential,
  CompanyConnectorProvider,
  CompanyConnectorSummary,
  CompanyConnectorUpsertRequest,
} from "@/lib/api";
import { cn, themedBody } from "@/lib/utils";

type ProviderCopy = {
  description: string;
  icon: typeof Link2;
  name: string;
  shortName: string;
};

const PROVIDERS: CompanyConnectorProvider[] = ["zoho", "google", "lark"];
const DEFAULT_LARK_API_BASE_URL = "https://open.larksuite.com";
const DEFAULT_ZOHO_ACCOUNTS_BASE_URL = "https://accounts.zoho.com";
const DEFAULT_ZOHO_API_BASE_URL = "https://www.zohoapis.com";
const DEFAULT_ZOHO_SCOPES = "ZohoBooks.fullaccess.all";

type ConnectorSetupDraft = {
  accounts_base_url: string;
  api_base_url: string;
  app_id: string;
  app_secret: string;
  client_id: string;
  client_secret: string;
  label: string;
  oauth_scopes: string;
  organization_id: string;
  refresh_token: string;
};

const PROVIDER_COPY: Record<CompanyConnectorProvider, ProviderCopy> = {
  zoho: {
    description: "Company-scoped Zoho Books credentials for finance tools.",
    icon: Building2,
    name: "Zoho Books",
    shortName: "Zoho",
  },
  google: {
    description: "Google Workspace credentials for Gmail, Drive, Calendar, and Docs tools.",
    icon: Mail,
    name: "Google Workspace",
    shortName: "Google",
  },
  lark: {
    description: "Company Lark app credentials for native Lark tools and contact enrichment.",
    icon: MessageSquare,
    name: "Lark",
    shortName: "Lark",
  },
};

function blankConnector(provider: CompanyConnectorProvider): CompanyConnectorSummary {
  return { connected: false, credentials: [], provider };
}

function initialSetupDraft(provider: CompanyConnectorProvider): ConnectorSetupDraft {
  return {
    accounts_base_url: DEFAULT_ZOHO_ACCOUNTS_BASE_URL,
    api_base_url:
      provider === "lark" ? DEFAULT_LARK_API_BASE_URL : DEFAULT_ZOHO_API_BASE_URL,
    app_id: "",
    app_secret: "",
    client_id: "",
    client_secret: "",
    label: provider === "zoho" ? "Zoho self-client" : `${PROVIDER_COPY[provider].name} app`,
    oauth_scopes: provider === "zoho" ? DEFAULT_ZOHO_SCOPES : "",
    organization_id: "",
    refresh_token: "",
  };
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function relativeTimestamp(value: string | null | undefined): string {
  if (!value) return "No timestamp";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const deltaSeconds = Math.round((Date.now() - date.getTime()) / 1000);
  const absSeconds = Math.abs(deltaSeconds);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, seconds] of units) {
    if (absSeconds >= seconds) {
      return rtf.format(-Math.round(deltaSeconds / seconds), unit);
    }
  }
  return "Just now";
}

function latestUpdatedAt(credentials: CompanyConnectorCredential[]): string | null {
  let latest = 0;
  for (const credential of credentials) {
    const raw = credential.updated_at || credential.created_at;
    if (!raw) continue;
    const time = new Date(raw).getTime();
    if (!Number.isNaN(time)) {
      latest = Math.max(latest, time);
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function isActiveCredential(credential: CompanyConnectorCredential): boolean {
  return credential.status === "active" && !credential.revoked_at;
}

function summarizeMetadata(metadata: Record<string, unknown>): Array<{ key: string; value: string }> {
  const result: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(metadata || {})) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      result.push({ key, value: value.join(", ") });
    } else if (typeof value === "object") {
      result.push({ key, value: JSON.stringify(value) });
    } else {
      result.push({ key, value: String(value) });
    }
  }
  return result.slice(0, 4);
}

function CredentialRow({ credential }: { credential: CompanyConnectorCredential }) {
  const active = isActiveCredential(credential);
  const metadata = summarizeMetadata(credential.metadata);

  return (
    <div className="rounded border border-border/60 bg-background-base/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={active ? "success" : "secondary"} className="capitalize">
            {credential.status || "unknown"}
          </Badge>
          <Badge tone="outline" className="capitalize">
            {credential.scope || "company"} scope
          </Badge>
          {credential.company_user_id ? (
            <Badge tone="outline" className="font-mono text-[10px]">
              {credential.company_user_id}
            </Badge>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground">
          Updated {relativeTimestamp(credential.updated_at || credential.created_at)}
        </div>
      </div>

      {metadata.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {metadata.map((item) => (
            <Badge key={item.key} tone="outline" className="max-w-full gap-1 text-[11px]">
              <span className="text-muted-foreground">{item.key}</span>
              <span className="max-w-[220px] truncate">{item.value}</span>
            </Badge>
          ))}
        </div>
      ) : (
        <div className="mt-3 text-xs text-muted-foreground">
          No non-secret metadata exposed.
        </div>
      )}

      <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <div>
          <span className="block uppercase tracking-[0.14em]">Created</span>
          <span className="text-foreground">{formatTimestamp(credential.created_at)}</span>
        </div>
        <div>
          <span className="block uppercase tracking-[0.14em]">Updated</span>
          <span className="text-foreground">{formatTimestamp(credential.updated_at)}</span>
        </div>
        <div>
          <span className="block uppercase tracking-[0.14em]">Revoked</span>
          <span className="text-foreground">{formatTimestamp(credential.revoked_at)}</span>
        </div>
      </div>
    </div>
  );
}

function SecretNotice() {
  return (
    <div className="rounded border border-border/60 bg-background-base/30 px-3 py-2 text-xs text-muted-foreground">
      Secrets are write-only. Hermes stores them encrypted and this page will only show
      non-secret status after save.
    </div>
  );
}

function ConnectorSetupPanel({
  draft,
  onCancel,
  onChange,
  onSubmit,
  provider,
  saving,
}: {
  draft: ConnectorSetupDraft;
  onCancel: () => void;
  onChange: (updates: Partial<ConnectorSetupDraft>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  provider: CompanyConnectorProvider;
  saving: boolean;
}) {
  const copy = PROVIDER_COPY[provider];

  return (
    <Card className="border-primary/35">
      <form onSubmit={onSubmit}>
        <CardHeader className="gap-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Configure connector
              </div>
              <CardTitle className="mt-1 text-lg">{copy.name}</CardTitle>
              <div className="mt-1 max-w-3xl text-sm text-muted-foreground">
                {provider === "zoho"
                  ? "Paste the Zoho Self Client credentials and refresh token. Hermes validates the refresh token once, stores it encrypted, and refreshes access tokens server-side."
                  : "Paste the company Lark app credentials used by native Hermes Lark tools and contact enrichment."}
              </div>
            </div>
            <Button
              ghost
              size="sm"
              type="button"
              className="uppercase"
              onClick={onCancel}
              prefix={<X className="h-4 w-4" />}
            >
              Cancel
            </Button>
          </div>
        </CardHeader>

        <CardContent className="grid gap-4 p-4 sm:p-5">
          <SecretNotice />

          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${provider}-label`}>Label</Label>
              <Input
                id={`${provider}-label`}
                value={draft.label}
                onChange={(event) => onChange({ label: event.target.value })}
                placeholder="Production"
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={`${provider}-api-base-url`}>API base URL</Label>
              <Input
                id={`${provider}-api-base-url`}
                value={draft.api_base_url}
                onChange={(event) => onChange({ api_base_url: event.target.value })}
                placeholder={
                  provider === "lark"
                    ? DEFAULT_LARK_API_BASE_URL
                    : DEFAULT_ZOHO_API_BASE_URL
                }
              />
            </div>
          </div>

          {provider === "lark" ? (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="lark-app-id">Lark app ID</Label>
                <Input
                  id="lark-app-id"
                  value={draft.app_id}
                  onChange={(event) => onChange({ app_id: event.target.value })}
                  placeholder="cli_..."
                  required
                  spellCheck={false}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lark-app-secret">Lark app secret</Label>
                <Input
                  id="lark-app-secret"
                  type="password"
                  value={draft.app_secret}
                  onChange={(event) => onChange({ app_secret: event.target.value })}
                  placeholder="App secret"
                  required
                  spellCheck={false}
                />
              </div>
            </div>
          ) : null}

          {provider === "zoho" ? (
            <div className="grid gap-4">
              <div className="rounded border border-border/60 bg-background-base/30 px-3 py-2 text-xs text-muted-foreground">
                Zoho Self Client flow: generate a grant code in the Zoho API Console,
                exchange it for a refresh token, then paste that refresh token here.
                Hermes will keep using the refresh token to rotate short-lived access
                tokens automatically.
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="zoho-client-id">Client ID</Label>
                  <Input
                    id="zoho-client-id"
                    value={draft.client_id}
                    onChange={(event) => onChange({ client_id: event.target.value })}
                    placeholder="1000..."
                    required
                    spellCheck={false}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zoho-client-secret">Client secret</Label>
                  <Input
                    id="zoho-client-secret"
                    type="password"
                    value={draft.client_secret}
                    onChange={(event) => onChange({ client_secret: event.target.value })}
                    placeholder="Client secret"
                    required
                    spellCheck={false}
                  />
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="zoho-refresh-token">Refresh token</Label>
                <textarea
                  id="zoho-refresh-token"
                  className="min-h-[92px] w-full border border-border bg-transparent px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  value={draft.refresh_token}
                  onChange={(event) => onChange({ refresh_token: event.target.value })}
                  placeholder="1000..."
                  required
                  spellCheck={false}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="zoho-organization-id">Books organization ID</Label>
                  <Input
                    id="zoho-organization-id"
                    value={draft.organization_id}
                    onChange={(event) => onChange({ organization_id: event.target.value })}
                    placeholder="Optional, recommended for production"
                    spellCheck={false}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zoho-accounts-base-url">Accounts base URL</Label>
                  <Input
                    id="zoho-accounts-base-url"
                    value={draft.accounts_base_url}
                    onChange={(event) =>
                      onChange({ accounts_base_url: event.target.value })
                    }
                    placeholder={DEFAULT_ZOHO_ACCOUNTS_BASE_URL}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zoho-scopes">Scopes</Label>
                  <Input
                    id="zoho-scopes"
                    value={draft.oauth_scopes}
                    onChange={(event) => onChange({ oauth_scopes: event.target.value })}
                    placeholder={DEFAULT_ZOHO_SCOPES}
                    spellCheck={false}
                  />
                </div>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              size="sm"
              className="uppercase"
              disabled={saving}
              prefix={saving ? <Spinner /> : <Save className="h-4 w-4" />}
            >
              {provider === "zoho"
                ? saving
                  ? "Validating..."
                  : "Validate & save"
                : saving
                  ? "Saving..."
                  : "Save connector"}
            </Button>
            <div className="text-xs text-muted-foreground">
              {provider === "zoho"
                ? "Validation calls Zoho once before encrypted storage."
                : "Saving updates the company-scoped Lark app credential."}
            </div>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}

function ConnectorCard({
  busy,
  connector,
  onConfigure,
  onDisconnect,
}: {
  busy: boolean;
  connector: CompanyConnectorSummary;
  onConfigure: (provider: CompanyConnectorProvider) => void;
  onDisconnect: (provider: CompanyConnectorProvider) => void;
}) {
  const copy = PROVIDER_COPY[connector.provider];
  const Icon = copy.icon;
  const canConfigure = connector.provider === "lark" || connector.provider === "zoho";
  const activeCredentials = connector.credentials.filter(isActiveCredential);
  const revokedCredentials = connector.credentials.filter(
    (credential) => credential.revoked_at || credential.status === "revoked",
  );
  const latest = latestUpdatedAt(connector.credentials);

  return (
    <Card className={cn(connector.connected ? "border-primary/35" : "border-border/70")}>
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-full border border-current/10 bg-background-base/40 p-2 text-primary">
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">{copy.name}</CardTitle>
              <div className="mt-1 text-sm text-muted-foreground">{copy.description}</div>
            </div>
          </div>
          <Badge tone={connector.connected ? "success" : "secondary"} className="shrink-0">
            {connector.connected ? "Connected" : "Not connected"}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded border border-border/60 bg-background-base/30 p-3">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <KeyRound className="h-3.5 w-3.5" />
              Active
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums">
              {activeCredentials.length}
            </div>
          </div>
          <div className="rounded border border-border/60 bg-background-base/30 p-3">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <Unplug className="h-3.5 w-3.5" />
              Revoked
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums">
              {revokedCredentials.length}
            </div>
          </div>
          <div className="rounded border border-border/60 bg-background-base/30 p-3">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" />
              Last change
            </div>
            <div className="mt-2 text-sm font-medium">{relativeTimestamp(latest)}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="uppercase"
            disabled={!canConfigure || busy}
            onClick={() => onConfigure(connector.provider)}
            prefix={<Link2 className="h-4 w-4" />}
            title={
              canConfigure
                ? `Configure ${copy.name}`
                : "Google OAuth setup is a separate follow-up slice."
            }
          >
            {connector.connected ? "Reconnect" : "Configure"}
          </Button>
          <Button
            ghost
            size="sm"
            className="uppercase"
            disabled={!connector.connected || busy}
            onClick={() => onDisconnect(connector.provider)}
            prefix={busy ? <Spinner /> : <Unplug className="h-4 w-4" />}
          >
            {busy ? "Disconnecting..." : "Disconnect"}
          </Button>
        </div>

        {connector.credentials.length > 0 ? (
          <div className="grid gap-3">
            {connector.credentials.map((credential) => (
              <CredentialRow key={credential.id} credential={credential} />
            ))}
          </div>
        ) : (
          <div className="rounded border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
            No credentials are stored for {copy.shortName}. Once OAuth setup is wired, the
            non-secret status will appear here.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ConnectorsPage() {
  const [companyId, setCompanyId] = useState("");
  const [connectors, setConnectors] = useState<CompanyConnectorSummary[]>(
    PROVIDERS.map(blankConnector),
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyProvider, setBusyProvider] = useState<CompanyConnectorProvider | null>(null);
  const [setupProvider, setSetupProvider] = useState<CompanyConnectorProvider | null>(null);
  const [setupDraft, setSetupDraft] = useState<ConnectorSetupDraft>(
    initialSetupDraft("lark"),
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const { toast, showToast } = useToast();
  const { setAfterTitle, setEnd, setTitle } = usePageHeader();

  const normalizeConnectors = useCallback((rows: CompanyConnectorSummary[]) => {
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    return PROVIDERS.map((provider) => byProvider.get(provider) ?? blankConnector(provider));
  }, []);

  const load = useCallback(
    async (soft = false) => {
      if (soft) {
        setRefreshing(true);
      }
      setLoadError(null);
      try {
        const response = await api.getCompanyConnectors();
        setCompanyId(response.company_id || "company_default");
        setConnectors(normalizeConnectors(response.connectors));
        setLastLoadedAt(new Date().toISOString());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLoadError(message);
        showToast(`Failed to load connectors: ${message}`, "error");
      } finally {
        if (soft) {
          setRefreshing(false);
        }
      }
    },
    [normalizeConnectors, showToast],
  );

  const configure = useCallback((provider: CompanyConnectorProvider) => {
    setSetupProvider(provider);
    setSetupDraft(initialSetupDraft(provider));
  }, []);

  const updateSetupDraft = useCallback((updates: Partial<ConnectorSetupDraft>) => {
    setSetupDraft((current) => ({ ...current, ...updates }));
  }, []);

  const saveConnector = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const provider = setupProvider;
      if (!provider) return;
      if (provider !== "lark" && provider !== "zoho") {
        showToast("Google setup is not wired in this slice.", "error");
        return;
      }

      const body: CompanyConnectorUpsertRequest =
        provider === "lark"
          ? {
              app_id: setupDraft.app_id.trim(),
              app_secret: setupDraft.app_secret.trim(),
              api_base_url:
                setupDraft.api_base_url.trim() || DEFAULT_LARK_API_BASE_URL,
              metadata: {
                label: setupDraft.label.trim() || "Lark app",
              },
            }
          : {
              client_id: setupDraft.client_id.trim(),
              client_secret: setupDraft.client_secret.trim(),
              refresh_token: setupDraft.refresh_token.trim(),
              organization_id: setupDraft.organization_id.trim(),
              accounts_base_url:
                setupDraft.accounts_base_url.trim() ||
                DEFAULT_ZOHO_ACCOUNTS_BASE_URL,
              api_base_url:
                setupDraft.api_base_url.trim() || DEFAULT_ZOHO_API_BASE_URL,
              oauth_scopes:
                setupDraft.oauth_scopes.trim() || DEFAULT_ZOHO_SCOPES,
              metadata: {
                label: setupDraft.label.trim() || "Zoho self-client",
                setup_method: "self_client",
              },
            };

      setBusyProvider(provider);
      try {
        const response = await api.upsertCompanyConnector(provider, body);
        setCompanyId(response.company_id || "company_default");
        setConnectors(normalizeConnectors(response.connectors));
        setLastLoadedAt(new Date().toISOString());
        setSetupProvider(null);
        showToast(
          provider === "zoho"
            ? "Zoho self-client credentials validated and saved"
            : "Lark app credentials saved",
          "success",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showToast(`Failed to save ${PROVIDER_COPY[provider].name}: ${message}`, "error");
      } finally {
        setBusyProvider(null);
      }
    },
    [normalizeConnectors, setupDraft, setupProvider, showToast],
  );

  const disconnect = useCallback(
    async (provider: CompanyConnectorProvider) => {
      const copy = PROVIDER_COPY[provider];
      const confirmed = window.confirm(
        `Disconnect ${copy.name} for this company workspace? Active credentials will be revoked.`,
      );
      if (!confirmed) return;

      setBusyProvider(provider);
      try {
        const response = await api.disconnectCompanyConnector(provider);
        setCompanyId(response.company_id || "company_default");
        setConnectors(normalizeConnectors(response.connectors));
        setLastLoadedAt(new Date().toISOString());
        showToast(
          response.revoked > 0
            ? `${copy.name} disconnected (${response.revoked} credential${response.revoked === 1 ? "" : "s"} revoked)`
            : `${copy.name} had no active credentials to revoke`,
          "success",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showToast(`Failed to disconnect ${copy.name}: ${message}`, "error");
      } finally {
        setBusyProvider(null);
      }
    },
    [normalizeConnectors, showToast],
  );

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      await load();
      if (!cancelled) {
        setLoading(false);
      }
    }

    void boot();

    return () => {
      cancelled = true;
    };
  }, [load]);

  const summary = useMemo(() => {
    const connected = connectors.filter((connector) => connector.connected).length;
    const active = connectors.reduce(
      (count, connector) => count + connector.credentials.filter(isActiveCredential).length,
      0,
    );
    const total = connectors.reduce((count, connector) => count + connector.credentials.length, 0);
    return { active, connected, total };
  }, [connectors]);

  useLayoutEffect(() => {
    setTitle("Connectors");
    setAfterTitle(
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="secondary" className="text-xs">
          {companyId || "company_default"}
        </Badge>
        <Badge tone="outline" className="text-xs tabular-nums">
          {summary.connected}/{PROVIDERS.length} connected
        </Badge>
      </div>,
    );
    setEnd(
      <Button
        className="uppercase"
        size="sm"
        onClick={() => void load(true)}
        disabled={refreshing}
        prefix={refreshing ? <Spinner /> : <RefreshCw className="h-4 w-4" />}
      >
        {refreshing ? "Refreshing..." : "Refresh"}
      </Button>,
    );
    return () => {
      setTitle(null);
      setAfterTitle(null);
      setEnd(null);
    };
  }, [
    companyId,
    load,
    refreshing,
    setAfterTitle,
    setEnd,
    setTitle,
    summary.connected,
  ]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="text-2xl text-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Toast toast={toast} />

      {setupProvider ? (
        <ConnectorSetupPanel
          draft={setupDraft}
          onCancel={() => setSetupProvider(null)}
          onChange={updateSetupDraft}
          onSubmit={saveConnector}
          provider={setupProvider}
          saving={busyProvider === setupProvider}
        />
      ) : null}

      {loadError && connectors.every((connector) => connector.credentials.length === 0) ? (
        <Card className="border-destructive/40">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">
                Connectors could not be loaded
              </div>
              <div className="mt-1 text-sm text-muted-foreground">{loadError}</div>
            </div>
            <Button
              className="shrink-0 uppercase"
              size="sm"
              onClick={() => void load(true)}
              disabled={refreshing}
              prefix={refreshing ? <Spinner /> : <RefreshCw className="h-4 w-4" />}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className={cn(themedBody, "grid gap-4 md:grid-cols-3")}>
        <Card>
          <CardContent className="flex items-start gap-3 p-4">
            <div className="rounded-full border border-current/10 bg-background-base/40 p-2 text-primary">
              <CheckCircle2 className="h-4 w-4" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Providers connected
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {summary.connected}/{PROVIDERS.length}
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-start gap-3 p-4">
            <div className="rounded-full border border-current/10 bg-background-base/40 p-2 text-primary">
              <KeyRound className="h-4 w-4" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Active credentials
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {summary.active}
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-start gap-3 p-4">
            <div className="rounded-full border border-current/10 bg-background-base/40 p-2 text-primary">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Secret policy
              </div>
              <div className="mt-1 text-sm font-medium">
                Status only; secrets never render in this UI.
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="gap-2">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Company connectors
              </div>
              <CardTitle className="mt-1 text-lg">Native Hermes credential status</CardTitle>
              <div className="mt-1 max-w-3xl text-sm text-muted-foreground">
                These credentials live in Hermes enterprise storage, scoped to the active company.
                Lark and Zoho can be configured here; Disconnect revokes stored credentials.
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge tone="outline" className="gap-1">
                <Building2 className="h-3.5 w-3.5" />
                {companyId || "company_default"}
              </Badge>
              <Badge tone="secondary" className="gap-1">
                <Clock3 className="h-3.5 w-3.5" />
                Updated {relativeTimestamp(lastLoadedAt)}
              </Badge>
            </div>
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        {connectors.map((connector) => (
          <ConnectorCard
            key={connector.provider}
            busy={busyProvider === connector.provider}
            connector={connector}
            onConfigure={configure}
            onDisconnect={disconnect}
          />
        ))}
      </div>
    </div>
  );
}
