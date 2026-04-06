import { useEffect, useMemo, useState } from 'react';
import { Bot, RefreshCw, Save } from 'lucide-react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { api } from '../lib/api';
import { toast } from '../components/ui/use-toast';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { Textarea } from '../components/ui/textarea';

type AssistantProfile = {
  companyId: string;
  companyContext: string;
  systemsOfRecord: string;
  businessRules: string;
  communicationStyle: string;
  formattingDefaults: string;
  restrictedClaims: string;
  isActive: boolean;
  revisionHash: string;
  hasContent: boolean;
};

type AssistantProfileForm = {
  companyContext: string;
  systemsOfRecord: string;
  businessRules: string;
  communicationStyle: string;
  formattingDefaults: string;
  restrictedClaims: string;
  isActive: boolean;
};

const EMPTY_FORM: AssistantProfileForm = {
  companyContext: '',
  systemsOfRecord: '',
  businessRules: '',
  communicationStyle: '',
  formattingDefaults: '',
  restrictedClaims: '',
  isActive: true,
};

const buildPreview = (form: AssistantProfileForm): string => {
  if (!form.isActive) {
    return 'Assistant profile is currently disabled.';
  }
  const lines = [
    form.companyContext ? `What the company does:\n${form.companyContext}` : '',
    form.systemsOfRecord ? `Systems of record:\n${form.systemsOfRecord}` : '',
    form.businessRules ? `Business rules:\n${form.businessRules}` : '',
    form.communicationStyle ? `Communication norms:\n${form.communicationStyle}` : '',
    form.formattingDefaults ? `Formatting defaults:\n${form.formattingDefaults}` : '',
    form.restrictedClaims ? `Do not assume or claim:\n${form.restrictedClaims}` : '',
  ].filter(Boolean);
  return lines.length > 0 ? lines.join('\n\n') : 'No company-level assistant profile configured yet.';
};

export const AssistantSettingsPage = () => {
  const { token, session } = useAdminAuth();
  const isSuperAdmin = session?.role === 'SUPER_ADMIN';
  const [companyId, setCompanyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profile, setProfile] = useState<AssistantProfile | null>(null);
  const [form, setForm] = useState<AssistantProfileForm>(EMPTY_FORM);

  const scopedCompanyId = useMemo(
    () => (isSuperAdmin ? companyId.trim() : undefined),
    [companyId, isSuperAdmin],
  );
  const requiresCompanySelection = Boolean(isSuperAdmin && !scopedCompanyId);

  const buildQuery = () =>
    scopedCompanyId ? `?companyId=${encodeURIComponent(scopedCompanyId)}` : '';

  const loadProfile = async () => {
    if (!token || requiresCompanySelection) {
      setLoading(false);
      setProfile(null);
      setForm(EMPTY_FORM);
      return;
    }
    setLoading(true);
    try {
      const data = await api.get<AssistantProfile>(
        `/api/admin/company/assistant-profile${buildQuery()}`,
        token,
      );
      setProfile(data);
      setForm({
        companyContext: data.companyContext,
        systemsOfRecord: data.systemsOfRecord,
        businessRules: data.businessRules,
        communicationStyle: data.communicationStyle,
        formattingDefaults: data.formattingDefaults,
        restrictedClaims: data.restrictedClaims,
        isActive: data.isActive,
      });
    } catch {
      setProfile(null);
      setForm(EMPTY_FORM);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadProfile();
  }, [token, scopedCompanyId, requiresCompanySelection]);

  const updateField = (field: keyof AssistantProfileForm, value: string | boolean) => {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const saveProfile = async () => {
    if (!token || requiresCompanySelection) {
      return;
    }
    setSaving(true);
    try {
      const saved = await api.put<AssistantProfile>(
        '/api/admin/company/assistant-profile',
        {
          companyId: scopedCompanyId,
          ...form,
        },
        token,
      );
      setProfile(saved);
      setForm({
        companyContext: saved.companyContext,
        systemsOfRecord: saved.systemsOfRecord,
        businessRules: saved.businessRules,
        communicationStyle: saved.communicationStyle,
        formattingDefaults: saved.formattingDefaults,
        restrictedClaims: saved.restrictedClaims,
        isActive: saved.isActive,
      });
      toast({
        title: 'Assistant profile saved',
        description: 'The next run will pick up the updated company-level profile.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="border-border/50 bg-card/40">
        <CardHeader className="space-y-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Bot className="h-5 w-5 text-primary" />
            Company Assistant Profile
          </CardTitle>
          <CardDescription>
            Define company-wide assistant context. Department prompt settings still override this,
            and user/runtime context overrides both.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isSuperAdmin ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Company Scope
              </div>
              <Input
                value={companyId}
                onChange={(event) => setCompanyId(event.target.value)}
                placeholder="Enter company UUID"
              />
            </div>
          ) : null}

          {requiresCompanySelection ? (
            <div className="rounded-2xl border border-dashed border-border/60 bg-muted/10 px-4 py-6 text-sm text-muted-foreground">
              Choose a company first to edit its assistant profile.
            </div>
          ) : loading ? (
            <div className="space-y-4">
              <Skeleton className="h-24 w-full rounded-2xl" />
              <Skeleton className="h-24 w-full rounded-2xl" />
              <Skeleton className="h-24 w-full rounded-2xl" />
            </div>
          ) : (
            <>
              <div className="grid gap-4 xl:grid-cols-2">
                <Field
                  label="Company Context"
                  value={form.companyContext}
                  onChange={(value) => updateField('companyContext', value)}
                  placeholder="What the company does, who it serves, and the operating context Divo should understand."
                />
                <Field
                  label="Systems Of Record"
                  value={form.systemsOfRecord}
                  onChange={(value) => updateField('systemsOfRecord', value)}
                  placeholder="Zoho Books for invoices, Lark for tasks, Gmail for email, and other authoritative systems."
                />
                <Field
                  label="Business Rules"
                  value={form.businessRules}
                  onChange={(value) => updateField('businessRules', value)}
                  placeholder="Approval expectations, finance rules, escalation norms, and other company-wide operating rules."
                />
                <Field
                  label="Communication Style"
                  value={form.communicationStyle}
                  onChange={(value) => updateField('communicationStyle', value)}
                  placeholder="Concise, direct, customer-safe, INR-first, or any other company tone norms."
                />
                <Field
                  label="Formatting Defaults"
                  value={form.formattingDefaults}
                  onChange={(value) => updateField('formattingDefaults', value)}
                  placeholder="Preferred formatting patterns for summaries, finance answers, and structured outputs."
                />
                <Field
                  label="Restricted Claims / Guardrails"
                  value={form.restrictedClaims}
                  onChange={(value) => updateField('restrictedClaims', value)}
                  placeholder="What Divo must not assume or claim without fresh system evidence."
                />
              </div>

              <label className="flex items-center gap-3 rounded-2xl border border-border/40 bg-muted/10 px-4 py-3 text-sm">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(event) => updateField('isActive', event.target.checked)}
                  className="h-4 w-4"
                />
                <span>Profile active</span>
              </label>

              <div className="flex items-center gap-3">
                <Button onClick={() => void saveProfile()} disabled={saving}>
                  {saving ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save profile
                </Button>
                <Button variant="outline" onClick={() => void loadProfile()} disabled={loading || saving}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Refresh
                </Button>
                {profile?.revisionHash ? (
                  <span className="text-xs text-muted-foreground">Revision: {profile.revisionHash}</span>
                ) : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50 bg-card/30">
        <CardHeader>
          <CardTitle className="text-base">Preview</CardTitle>
          <CardDescription>
            This shows only the company profile block. Department settings and user/runtime context
            are applied later and can override this content.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="whitespace-pre-wrap rounded-2xl border border-border/40 bg-muted/10 p-4 text-sm leading-6 text-foreground">
            {buildPreview(form)}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
};

const Field = (input: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) => (
  <div className="space-y-2">
    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
      {input.label}
    </div>
    <Textarea
      value={input.value}
      onChange={(event) => input.onChange(event.target.value)}
      placeholder={input.placeholder}
      className="min-h-[150px]"
    />
  </div>
);
