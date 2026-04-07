import { useEffect, useMemo, useState } from 'react';
import { Bot, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { api } from '../lib/api';
import { toast } from '../components/ui/use-toast';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { ScrollArea } from '../components/ui/scroll-area';
import { Skeleton } from '../components/ui/skeleton';
import { Textarea } from '../components/ui/textarea';

type ToolRow = {
  toolId: string;
  name: string;
  description: string;
  category: string;
};

type ToolMatrix = {
  roles: Array<{ id: string; slug: string }>;
  tools: ToolRow[];
};

type DepartmentListItem = {
  id: string;
  name: string;
  slug: string;
};

type AgentProfile = {
  id: string;
  companyId: string;
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  modelKey: string;
  toolIds: string[];
  routingHints: string[];
  departmentIds: string[];
  isActive: boolean;
  isSeeded: boolean;
  revisionHash: string;
};

type AgentProfileForm = {
  profileId?: string;
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  modelKey: string;
  toolIds: string[];
  routingHints: string;
  departmentIds: string[];
  isActive: boolean;
  isSeeded: boolean;
};

const EMPTY_FORM: AgentProfileForm = {
  slug: '',
  name: '',
  description: '',
  systemPrompt: '',
  modelKey: 'gemini-3.1-flash-lite-preview',
  toolIds: [],
  routingHints: '',
  departmentIds: [],
  isActive: true,
  isSeeded: false,
};

const toForm = (profile: AgentProfile): AgentProfileForm => ({
  profileId: profile.isSeeded ? undefined : profile.id,
  slug: profile.slug,
  name: profile.name,
  description: profile.description,
  systemPrompt: profile.systemPrompt,
  modelKey: profile.modelKey,
  toolIds: profile.toolIds,
  routingHints: profile.routingHints.join(', '),
  departmentIds: profile.departmentIds,
  isActive: profile.isActive,
  isSeeded: profile.isSeeded,
});

export const AgentProfilesSettingsPage = () => {
  const { token, session } = useAdminAuth();
  const isSuperAdmin = session?.role === 'SUPER_ADMIN';
  const [companyId, setCompanyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<AgentProfileForm>(EMPTY_FORM);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [departments, setDepartments] = useState<DepartmentListItem[]>([]);

  const scopedCompanyId = useMemo(
    () => (isSuperAdmin ? companyId.trim() : undefined),
    [companyId, isSuperAdmin],
  );
  const requiresCompanySelection = Boolean(isSuperAdmin && !scopedCompanyId);
  const buildQuery = () =>
    scopedCompanyId ? `?companyId=${encodeURIComponent(scopedCompanyId)}` : '';

  const loadAll = async () => {
    if (!token || requiresCompanySelection) {
      setLoading(false);
      setProfiles([]);
      setTools([]);
      setDepartments([]);
      setSelectedId(null);
      setForm(EMPTY_FORM);
      return;
    }
    setLoading(true);
    try {
      const [agentProfiles, toolMatrix, departmentList] = await Promise.all([
        api.get<AgentProfile[]>(`/api/admin/company/agent-profiles${buildQuery()}`, token),
        api.get<ToolMatrix>(`/api/admin/company/tool-permissions${buildQuery()}`, token),
        api.get<DepartmentListItem[]>(
          `/api/admin/departments${scopedCompanyId ? `?companyId=${encodeURIComponent(scopedCompanyId)}` : ''}`,
          token,
        ),
      ]);
      setProfiles(agentProfiles);
      setTools(toolMatrix.tools);
      setDepartments(departmentList);
      const nextSelected = agentProfiles.find((profile) => profile.id === selectedId) ?? agentProfiles[0];
      setSelectedId(nextSelected?.id ?? null);
      setForm(nextSelected ? toForm(nextSelected) : EMPTY_FORM);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, [token, scopedCompanyId, requiresCompanySelection]);

  const selectProfile = (profile: AgentProfile) => {
    setSelectedId(profile.id);
    setForm(toForm(profile));
  };

  const createNewProfile = () => {
    setSelectedId(null);
    setForm(EMPTY_FORM);
  };

  const toggleTool = (toolId: string) => {
    setForm((current) => {
      const next = new Set(current.toolIds);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return { ...current, toolIds: Array.from(next) };
    });
  };

  const toggleDepartment = (departmentId: string) => {
    setForm((current) => {
      const next = new Set(current.departmentIds);
      if (next.has(departmentId)) next.delete(departmentId);
      else next.add(departmentId);
      return { ...current, departmentIds: Array.from(next) };
    });
  };

  const saveProfile = async () => {
    if (!token || requiresCompanySelection) return;
    setSaving(true);
    try {
      await api.put<AgentProfile>(
        '/api/admin/company/agent-profiles',
        {
          companyId: scopedCompanyId,
          profileId: form.profileId,
          slug: form.slug,
          name: form.name,
          description: form.description,
          systemPrompt: form.systemPrompt,
          modelKey: form.modelKey,
          toolIds: form.toolIds,
          routingHints: form.routingHints.split(',').map((entry) => entry.trim()).filter(Boolean),
          departmentIds: form.departmentIds,
          isActive: form.isActive,
        },
        token,
      );
      toast({
        title: 'Agent profile saved',
        description: 'The company agent inventory has been updated.',
      });
      await loadAll();
    } finally {
      setSaving(false);
    }
  };

  const deleteProfile = async () => {
    if (!token || !selectedId || !form.profileId || requiresCompanySelection) return;
    await api.delete(
      `/api/admin/company/agent-profiles/${selectedId}${buildQuery()}`,
      {},
      token,
    );
    toast({
      title: 'Agent profile deleted',
      description: 'Department assignments were cleared where needed.',
    });
    await loadAll();
  };

  return (
    <div className="space-y-6">
      <Card className="border-border/50 bg-card/40">
        <CardHeader className="space-y-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Bot className="h-5 w-5 text-primary" />
            Company Agent Profiles
          </CardTitle>
          <CardDescription>
            Build a company inventory of agent profiles. Tool approvals remain inherited from tool policy.
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
              Choose a company first to edit its agent inventory.
            </div>
          ) : loading ? (
            <div className="space-y-4">
              <Skeleton className="h-24 w-full rounded-2xl" />
              <Skeleton className="h-24 w-full rounded-2xl" />
              <Skeleton className="h-24 w-full rounded-2xl" />
            </div>
          ) : (
            <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
              <Card className="border-border/50 bg-background/40">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">Profiles</CardTitle>
                    <Button variant="outline" size="sm" onClick={createNewProfile}>
                      <Plus className="mr-2 h-3.5 w-3.5" />
                      New
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <ScrollArea className="h-[560px] pr-3">
                    <div className="space-y-2">
                      {profiles.map((profile) => (
                        <button
                          key={profile.id}
                          type="button"
                          onClick={() => selectProfile(profile)}
                          className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                            selectedId === profile.id
                              ? 'border-primary bg-primary/10'
                              : 'border-border/50 bg-muted/10 hover:bg-muted/20'
                          }`}
                        >
                          <div className="text-sm font-semibold text-foreground">{profile.name}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{profile.description || profile.slug}</div>
                          <div className="mt-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                            {profile.isSeeded ? 'Seed profile' : profile.isActive ? 'Active' : 'Inactive'}
                          </div>
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>

              <div className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Name" value={form.name} onChange={(value) => setForm((current) => ({ ...current, name: value }))} />
                  <Field label="Slug" value={form.slug} onChange={(value) => setForm((current) => ({ ...current, slug: value }))} />
                  <Field label="Model" value={form.modelKey} onChange={(value) => setForm((current) => ({ ...current, modelKey: value }))} />
                  <Field label="Routing hints" value={form.routingHints} onChange={(value) => setForm((current) => ({ ...current, routingHints: value }))} placeholder="gmail, inbox, follow up" />
                </div>

                <Field
                  label="Description"
                  value={form.description}
                  onChange={(value) => setForm((current) => ({ ...current, description: value }))}
                  multiline
                  rows={3}
                />
                <Field
                  label="System Prompt"
                  value={form.systemPrompt}
                  onChange={(value) => setForm((current) => ({ ...current, systemPrompt: value }))}
                  multiline
                  rows={10}
                />

                <label className="flex items-center gap-3 rounded-2xl border border-border/40 bg-muted/10 px-4 py-3 text-sm">
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.checked }))}
                    className="h-4 w-4"
                  />
                  <span>Profile active</span>
                </label>

                <Card className="border-border/50 bg-background/40">
                  <CardHeader>
                    <CardTitle className="text-sm">Allowed Tools</CardTitle>
                    <CardDescription>Select the runtime tools this agent profile may use.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid gap-3 md:grid-cols-2">
                      {tools.map((tool) => {
                        const checked = form.toolIds.includes(tool.toolId);
                        return (
                          <label key={tool.toolId} className="flex items-start gap-3 rounded-xl border border-border/40 p-3 text-sm">
                            <input type="checkbox" checked={checked} onChange={() => toggleTool(tool.toolId)} className="mt-1 h-4 w-4" />
                            <span>
                              <span className="block font-medium text-foreground">{tool.name}</span>
                              <span className="block text-xs text-muted-foreground">{tool.description}</span>
                              <span className="block text-[10px] uppercase text-muted-foreground">{tool.toolId}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-border/50 bg-background/40">
                  <CardHeader>
                    <CardTitle className="text-sm">Department Availability</CardTitle>
                    <CardDescription>
                      Leave all unchecked to make the profile available company-wide. Department config still decides default vs specialist assignment.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid gap-3 md:grid-cols-2">
                      {departments.map((department) => {
                        const checked = form.departmentIds.includes(department.id);
                        return (
                          <label key={department.id} className="flex items-center gap-3 rounded-xl border border-border/40 p-3 text-sm">
                            <input type="checkbox" checked={checked} onChange={() => toggleDepartment(department.id)} className="h-4 w-4" />
                            <span>
                              <span className="block font-medium text-foreground">{department.name}</span>
                              <span className="block text-[10px] uppercase text-muted-foreground">{department.slug}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>

                <div className="flex items-center gap-3">
                  <Button onClick={() => void saveProfile()} disabled={saving}>
                    {saving ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Save profile
                  </Button>
                  <Button variant="outline" onClick={() => void loadAll()} disabled={loading || saving}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Refresh
                  </Button>
                  <Button variant="destructive" onClick={() => void deleteProfile()} disabled={!form.profileId || form.isSeeded}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

function Field(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {props.label}
      </div>
      {props.multiline ? (
        <Textarea
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={props.placeholder}
          rows={props.rows ?? 4}
        />
      ) : (
        <Input
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={props.placeholder}
        />
      )}
    </div>
  );
}
