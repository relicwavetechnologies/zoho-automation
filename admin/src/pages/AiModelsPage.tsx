import { useEffect, useMemo, useState } from 'react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { toast } from '../components/ui/use-toast';
import { api } from '../lib/api';

type Provider = 'google' | 'openai';
type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

type CatalogEntry = {
  provider: Provider;
  modelId: string;
  label: string;
  description: string;
  preview?: boolean;
  supportsThinking?: boolean;
  speed: 'fast' | 'balanced' | 'strong';
  cost: 'cheap' | 'balanced' | 'premium';
};

type TargetRow = {
  targetKey: string;
  label: string;
  description: string;
  engine: 'mastra' | 'langgraph';
  kind: 'supervisor' | 'specialist' | 'router' | 'planner' | 'synthesis' | 'ack';
  effectiveProvider: Provider;
  effectiveModelId: string;
  effectiveThinkingLevel?: ThinkingLevel;
  source: 'default' | 'override';
  override?: {
    provider: Provider;
    modelId: string;
    thinkingLevel?: ThinkingLevel;
    updatedBy: string;
    updatedAt: string;
  };
};

type ControlPlaneResponse = {
  thinkingLevels: ThinkingLevel[];
  catalog: CatalogEntry[];
  targets: TargetRow[];
};

type DraftState = {
  provider: Provider;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
};

const ENGINE_ACCENT: Record<'mastra' | 'langgraph', string> = {
  mastra: 'border-violet-900 bg-violet-950/50 text-violet-300',
  langgraph: 'border-sky-900 bg-sky-950/50 text-sky-300',
};

const SOURCE_ACCENT: Record<'default' | 'override', string> = {
  default: 'border-zinc-700 bg-zinc-900 text-zinc-300',
  override: 'border-emerald-900 bg-emerald-950/60 text-emerald-300',
};

export function AiModelsPage() {
  const { token, session } = useAdminAuth();
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<ThinkingLevel[]>([]);
  const [targets, setTargets] = useState<TargetRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const data = await api.get<ControlPlaneResponse>('/api/admin/ai-models', token);
      setCatalog(data.catalog);
      setThinkingLevels(data.thinkingLevels);
      setTargets(data.targets);
      setDrafts(
        Object.fromEntries(
          data.targets.map((target) => [
            target.targetKey,
            {
              provider: target.effectiveProvider,
              modelId: target.effectiveModelId,
              thinkingLevel: target.effectiveThinkingLevel,
            },
          ]),
        ),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token]);

  const modelsByProvider = useMemo(() => {
    return {
      google: catalog.filter((entry) => entry.provider === 'google'),
      openai: catalog.filter((entry) => entry.provider === 'openai'),
    };
  }, [catalog]);

  const groupedTargets = useMemo(() => {
    return {
      mastra: targets.filter((target) => target.engine === 'mastra'),
      langgraph: targets.filter((target) => target.engine === 'langgraph'),
    };
  }, [targets]);

  const updateDraft = (targetKey: string, patch: Partial<DraftState>) => {
    setDrafts((prev) => {
      const next = { ...prev[targetKey], ...patch } as DraftState;
      if (patch.provider && patch.provider !== prev[targetKey]?.provider) {
        const providerModels = modelsByProvider[patch.provider];
        next.modelId = providerModels[0]?.modelId ?? '';
        next.thinkingLevel = providerModels[0]?.supportsThinking ? 'medium' : undefined;
      }
      return { ...prev, [targetKey]: next };
    });
  };

  const handleSave = async (target: TargetRow) => {
    if (!token) return;
    const draft = drafts[target.targetKey];
    if (!draft?.modelId) return;

    setSavingKey(target.targetKey);
    try {
      const updated = await api.put<TargetRow>(
        `/api/admin/ai-models/${encodeURIComponent(target.targetKey)}`,
        {
          provider: draft.provider,
          modelId: draft.modelId,
          thinkingLevel: draft.provider === 'google' ? draft.thinkingLevel ?? null : null,
        },
        token,
      );
      setTargets((prev) => prev.map((row) => (row.targetKey === updated.targetKey ? updated : row)));
      setDrafts((prev) => ({
        ...prev,
        [updated.targetKey]: {
          provider: updated.effectiveProvider,
          modelId: updated.effectiveModelId,
          thinkingLevel: updated.effectiveThinkingLevel,
        },
      }));
      toast({ title: 'AI model updated', description: `${updated.label} now uses ${updated.effectiveProvider}/${updated.effectiveModelId}.`, variant: 'success' });
    } catch {
      // api util shows the error toast
    } finally {
      setSavingKey(null);
    }
  };

  if (session?.role !== 'SUPER_ADMIN') {
    return (
      <Card className="border-zinc-800 bg-[#111315] text-zinc-100">
        <CardHeader>
          <CardTitle>AI Models</CardTitle>
          <CardDescription className="text-zinc-400">
            This panel is only available to super-admin sessions.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full bg-zinc-900" />
        <Skeleton className="h-40 w-full bg-zinc-900" />
        <Skeleton className="h-40 w-full bg-zinc-900" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="border-zinc-800 bg-[#111315] text-zinc-100">
        <CardHeader>
          <CardTitle>AI Model Control Plane</CardTitle>
          <CardDescription className="text-zinc-400">
            Configure provider, model, and Gemini thinking level per Mastra and LangGraph target. Supervisor defaults have been moved to Gemini, but every target here is switchable.
          </CardDescription>
        </CardHeader>
      </Card>

      {(['mastra', 'langgraph'] as const).map((engine) => (
        <section key={engine} className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge className={ENGINE_ACCENT[engine]}>{engine === 'mastra' ? 'Mastra' : 'LangGraph'}</Badge>
            <span className="text-sm text-zinc-400">
              {engine === 'mastra' ? 'Runtime agents and specialist delegation' : 'Planner/router/synthesis orchestration models'}
            </span>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            {groupedTargets[engine].map((target) => {
              const draft = drafts[target.targetKey];
              const models = draft ? modelsByProvider[draft.provider] : [];
              const selectedModel = models.find((entry) => entry.modelId === draft?.modelId);
              return (
                <Card key={target.targetKey} className="border-zinc-800 bg-[#111315] text-zinc-100 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
                  <CardHeader className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-base">{target.label}</CardTitle>
                      <Badge className={SOURCE_ACCENT[target.source]}>{target.source === 'override' ? 'Override' : 'Default'}</Badge>
                      <Badge variant="outline" className="border-zinc-700 text-zinc-300">{target.kind}</Badge>
                    </div>
                    <CardDescription className="text-zinc-400">{target.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <div className="text-xs font-medium uppercase tracking-[0.12em] text-zinc-500">Provider</div>
                        <Select value={draft?.provider} onValueChange={(value) => updateDraft(target.targetKey, { provider: value as Provider })}>
                          <SelectTrigger className="border-zinc-800 bg-zinc-950 text-zinc-100">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="border-zinc-800 bg-[#111315] text-zinc-100">
                            <SelectItem value="google">Google Gemini</SelectItem>
                            <SelectItem value="openai">OpenAI</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <div className="text-xs font-medium uppercase tracking-[0.12em] text-zinc-500">Model</div>
                        <Select value={draft?.modelId} onValueChange={(value) => updateDraft(target.targetKey, { modelId: value })}>
                          <SelectTrigger className="border-zinc-800 bg-zinc-950 text-zinc-100">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="border-zinc-800 bg-[#111315] text-zinc-100">
                            {models.map((model) => (
                              <SelectItem key={`${model.provider}:${model.modelId}`} value={model.modelId}>
                                {model.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {draft?.provider === 'google' && selectedModel?.supportsThinking ? (
                      <div className="space-y-2">
                        <div className="text-xs font-medium uppercase tracking-[0.12em] text-zinc-500">Thinking Level</div>
                        <Select
                          value={draft.thinkingLevel ?? 'medium'}
                          onValueChange={(value) => updateDraft(target.targetKey, { thinkingLevel: value as ThinkingLevel })}
                        >
                          <SelectTrigger className="border-zinc-800 bg-zinc-950 text-zinc-100">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="border-zinc-800 bg-[#111315] text-zinc-100">
                            {thinkingLevels.map((level) => (
                              <SelectItem key={level} value={level}>
                                {level}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : null}

                    {selectedModel ? (
                      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 text-sm text-zinc-300">
                        <div className="flex flex-wrap items-center gap-2 pb-2">
                          <Badge variant="outline" className="border-zinc-700 text-zinc-300">{selectedModel.speed}</Badge>
                          <Badge variant="outline" className="border-zinc-700 text-zinc-300">{selectedModel.cost}</Badge>
                          {selectedModel.preview ? <Badge className="border-amber-900 bg-amber-950/60 text-amber-300">Preview</Badge> : null}
                        </div>
                        <div>{selectedModel.description}</div>
                      </div>
                    ) : null}

                    {target.override ? (
                      <div className="text-xs text-zinc-500">
                        Last override by <span className="text-zinc-300">{target.override.updatedBy}</span> on{' '}
                        <span className="text-zinc-300">{new Date(target.override.updatedAt).toLocaleString()}</span>
                      </div>
                    ) : null}

                    <div className="flex justify-end">
                      <Button
                        onClick={() => handleSave(target)}
                        disabled={savingKey === target.targetKey}
                        className="bg-zinc-100 text-zinc-950 hover:bg-white"
                      >
                        {savingKey === target.targetKey ? 'Saving...' : 'Save Target'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
