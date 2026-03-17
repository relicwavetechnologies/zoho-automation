import { useEffect, useMemo, useState } from 'react';
import { Cpu, Shield, Zap, Info, Save, Layers, Box, Globe, MessageSquare, Terminal } from 'lucide-react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { toast } from '../components/ui/use-toast';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { Separator } from '../components/ui/separator';

type Provider = 'google' | 'openai' | 'groq';
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
    fastProvider?: Provider;
    fastModelId?: string;
    fastThinkingLevel?: ThinkingLevel;
    xtremeProvider?: Provider;
    xtremeModelId?: string;
    xtremeThinkingLevel?: ThinkingLevel;
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
  fastProvider: Provider;
  fastModelId: string;
  fastThinkingLevel?: ThinkingLevel;
  xtremeProvider: Provider;
  xtremeModelId: string;
  xtremeThinkingLevel?: ThinkingLevel;
};

const ENGINE_CONFIG: Record<'mastra' | 'langgraph', { label: string; icon: any; color: string }> = {
  mastra: { label: 'Mastra Runtime', icon: Globe, color: 'text-violet-500' },
  langgraph: { label: 'LangGraph Orchestrator', icon: Layers, color: 'text-sky-500' },
};

export function AiModelsPage() {
  const { token, session } = useAdminAuth();
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<ThinkingLevel[]>([]);
  const [targets, setTargets] = useState<TargetRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = async (options?: { silent?: boolean }) => {
    if (!token) return;
    if (!options?.silent) setLoading(true);
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
              fastProvider: target.override?.fastProvider ?? (target as any).fastEffectiveProvider ?? target.effectiveProvider,
              fastModelId: target.override?.fastModelId ?? (target as any).fastEffectiveModelId ?? target.effectiveModelId,
              fastThinkingLevel: target.override?.fastThinkingLevel ?? (target as any).fastEffectiveThinkingLevel ?? target.effectiveThinkingLevel,
              xtremeProvider: target.override?.xtremeProvider ?? (target as any).xtremeEffectiveProvider ?? target.effectiveProvider,
              xtremeModelId: target.override?.xtremeModelId ?? (target as any).xtremeEffectiveModelId ?? target.effectiveModelId,
              xtremeThinkingLevel: target.override?.xtremeThinkingLevel ?? (target as any).xtremeEffectiveThinkingLevel ?? target.effectiveThinkingLevel,
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
      groq: catalog.filter((entry) => entry.provider === 'groq'),
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
          fastProvider: draft.fastProvider,
          fastModelId: draft.fastModelId,
          fastThinkingLevel: draft.fastProvider === 'google' ? draft.fastThinkingLevel ?? null : null,
          xtremeProvider: draft.xtremeProvider,
          xtremeModelId: draft.xtremeModelId,
          xtremeThinkingLevel: draft.xtremeProvider === 'google' ? draft.xtremeThinkingLevel ?? null : null,
        },
        token,
      );
      await load({ silent: true });
      toast({ title: 'AI model updated', variant: 'success' });
    } finally {
      setSavingKey(null);
    }
  };

  if (session?.role !== 'SUPER_ADMIN') {
    return (
      <div className="p-12 text-center border border-dashed border-border/50 rounded-2xl bg-secondary/5">
        <Shield className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-20" />
        <h3 className="text-lg font-bold">Access Restricted</h3>
        <p className="text-sm text-muted-foreground mt-1">This control plane is only available to platform administrators.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-32 w-full rounded-2xl" />
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="h-64 w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10 w-full animate-in fade-in duration-700 pb-20">
      <div className="p-6 rounded-2xl border border-border/50 bg-secondary/5 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Cpu className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-bold">Model Control Plane</h2>
          </div>
          <p className="text-xs text-muted-foreground max-w-2xl">
            Configure primary, latency-optimized, and high-performance model targets for all platform orchestration layers.
          </p>
        </div>
        <div className="flex items-center gap-4 bg-background border border-border/50 rounded-xl px-4 py-2">
          <div className="flex flex-col items-center">
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest leading-none mb-1">Catalog</span>
            <span className="text-sm font-bold">{catalog.length} Models</span>
          </div>
          <Separator orientation="vertical" className="h-8" />
          <div className="flex flex-col items-center">
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest leading-none mb-1">Targets</span>
            <span className="text-sm font-bold">{targets.length} Active</span>
          </div>
        </div>
      </div>

      {(['mastra', 'langgraph'] as const).map((engine) => {
        const Config = ENGINE_CONFIG[engine];
        const Icon = Config.icon;
        return (
          <section key={engine} className="space-y-6">
            <div className="flex items-center gap-3 ml-1">
              <div className={cn("h-8 w-8 rounded-lg bg-secondary/50 flex items-center justify-center", Config.color)}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="space-y-0.5">
                <h3 className="text-sm font-bold uppercase tracking-wider">{Config.label}</h3>
                <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-tighter">
                  {engine === 'mastra' ? 'Specialist agents and tools' : 'Planner and router orchestration'}
                </p>
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-2">
              {groupedTargets[engine].map((target) => {
                const draft = drafts[target.targetKey];
                const isSaving = savingKey === target.targetKey;
                return (
                  <Card key={target.targetKey} className="bg-card border-border/50 shadow-md overflow-hidden group hover:border-primary/30 transition-all duration-300">
                    <CardHeader className="border-b border-border/50 bg-secondary/5 px-6 py-4 flex flex-row items-start justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <CardTitle className="text-base font-bold">{target.label}</CardTitle>
                          <Badge variant="outline" className={cn(
                            "text-[9px] h-4 font-bold uppercase tracking-tighter",
                            target.source === 'override' ? "bg-emerald-500/5 text-emerald-500 border-emerald-500/10" : "text-muted-foreground"
                          )}>
                            {target.source === 'override' ? 'Custom' : 'System'}
                          </Badge>
                        </div>
                        <CardDescription className="text-[11px] leading-relaxed line-clamp-1">{target.description}</CardDescription>
                      </div>
                      <Badge variant="secondary" className="text-[9px] h-4 font-mono uppercase bg-secondary/50">{target.kind}</Badge>
                    </CardHeader>
                    <CardContent className="p-6 space-y-6">
                      <Tabs defaultValue="high" className="w-full">
                        <TabsList className="bg-secondary/30 h-9 p-1 gap-1">
                          <TabsTrigger value="high" className="flex-1 text-[10px] font-bold uppercase tracking-wider h-7 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                            <Shield className="h-3 w-3 mr-1.5" /> High Tier
                          </TabsTrigger>
                          <TabsTrigger value="fast" className="flex-1 text-[10px] font-bold uppercase tracking-wider h-7 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                            <Zap className="h-3 w-3 mr-1.5 text-amber-500" /> Fast Tier
                          </TabsTrigger>
                          <TabsTrigger value="xtreme" className="flex-1 text-[10px] font-bold uppercase tracking-wider h-7 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                            <Layers className="h-3 w-3 mr-1.5 text-primary" /> Xtreme
                          </TabsTrigger>
                        </TabsList>

                        {/* Rendering a common form component for all tiers */}
                        {['high', 'fast', 'xtreme'].map((tier) => (
                          <TabsContent key={tier} value={tier} className="mt-6 space-y-4 animate-in fade-in slide-in-from-bottom-1 duration-300">
                            <div className="grid grid-cols-2 gap-4">
                              <div className="space-y-1.5">
                                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground ml-1">Provider</label>
                                <Select 
                                  value={tier === 'high' ? draft?.provider : tier === 'fast' ? draft?.fastProvider : draft?.xtremeProvider} 
                                  onValueChange={(val) => updateDraft(target.targetKey, tier === 'high' ? { provider: val as Provider } : tier === 'fast' ? { fastProvider: val as Provider } : { xtremeProvider: val as Provider })}
                                >
                                  <SelectTrigger className="bg-secondary/20 border-border/50 h-9 text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="google">Google Gemini</SelectItem>
                                    <SelectItem value="openai">OpenAI</SelectItem>
                                    <SelectItem value="groq">Groq LPU</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="space-y-1.5">
                                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground ml-1">Model ID</label>
                                <Select 
                                  value={tier === 'high' ? draft?.modelId : tier === 'fast' ? draft?.fastModelId : draft?.xtremeModelId} 
                                  onValueChange={(val) => updateDraft(target.targetKey, tier === 'high' ? { modelId: val } : tier === 'fast' ? { fastModelId: val } : { xtremeModelId: val })}
                                >
                                  <SelectTrigger className="bg-secondary/20 border-border/50 h-9 text-xs font-mono">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {modelsByProvider[(tier === 'high' ? draft?.provider : tier === 'fast' ? draft?.fastProvider : draft?.xtremeProvider) || 'google'].map(m => (
                                      <SelectItem key={m.modelId} value={m.modelId} className="text-xs font-mono">{m.label}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>

                            {tier === 'high' && draft?.provider === 'google' && (
                              <div className="space-y-1.5">
                                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground ml-1">Thinking Level</label>
                                <Select value={draft.thinkingLevel || 'medium'} onValueChange={(v) => updateDraft(target.targetKey, { thinkingLevel: v as ThinkingLevel })}>
                                  <SelectTrigger className="bg-secondary/20 border-border/50 h-9 text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {thinkingLevels.map(l => <SelectItem key={l} value={l} className="capitalize">{l}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}

                            <div className="p-3 rounded-lg border border-border/30 bg-secondary/5 flex items-start gap-3">
                              <Info className="h-3.5 w-3.5 text-muted-foreground mt-0.5" />
                              <p className="text-[10px] leading-relaxed text-muted-foreground">
                                {catalog.find(m => m.modelId === (tier === 'high' ? draft?.modelId : tier === 'fast' ? draft?.fastModelId : draft?.xtremeModelId))?.description || "Select a model to see its performance profile."}
                              </p>
                            </div>
                          </TabsContent>
                        ))}
                      </Tabs>

                      <div className="pt-2 flex items-center justify-between">
                        <div className="text-[10px] text-muted-foreground font-medium italic">
                          {target.override ? `Last sync ${new Date(target.override.updatedAt).toLocaleDateString()}` : 'Using system default'}
                        </div>
                        <Button 
                          size="sm" 
                          onClick={() => handleSave(target)} 
                          disabled={isSaving}
                          className="h-8 px-4 text-[10px] font-bold uppercase tracking-widest shadow-sm"
                        >
                          {isSaving ? <Box className="h-3 w-3 animate-spin mr-2" /> : <Save className="h-3 w-3 mr-2" />}
                          Update Target
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
