import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Bot,
  Plus,
  Trash2,
  Edit,
  ToggleLeft,
  ToggleRight,
  Search,
  RefreshCw,
  Box,
  Link2,
  Unlink,
  Terminal,
  Shield,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

import { useAdminAuth } from "../auth/AdminAuthProvider";
import {
  agentsApi,
  channelMappingsApi,
  type CreateAgentInput,
  type UpdateAgentInput,
  type ModelCatalogEntry,
} from "../lib/api";
import { toast } from "../components/ui/use-toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Textarea } from "../components/ui/textarea";
import { ScrollArea } from "../components/ui/scroll-area";
import { cn } from "../lib/utils";
import { Separator } from "../components/ui/separator";

type Agent = {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  isRootAgent: boolean;
  toolIds: string[];
  parentId?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  modelId?: string;
  provider?: string;
};

type ToolDefinition = {
  toolId: string;
  name: string;
  description: string;
  category: string;
  promptSnippet: string;
  isDeprecated: boolean;
};

type ChannelMapping = {
  channelType: "lark" | "desktop";
  channelIdentifier: string;
  agentDefinitionId: string;
  agentName?: string;
  isActive: boolean;
};

const AGENTS_TABS = ["agents", "mappings"] as const;
type AgentsTab = (typeof AGENTS_TABS)[number];

const isAgentsTab = (value: string | null): value is AgentsTab =>
  Boolean(value && AGENTS_TABS.includes(value as AgentsTab));

export const AgentsPage = () => {
  const { token } = useAdminAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [mappings, setMappings] = useState<ChannelMapping[]>([]);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);

  // Agent Builder State
  const [isBuilderOpen, setIsBuilderOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [builderForm, setBuilderForm] = useState<CreateAgentInput>({
    name: "",
    description: "",
    systemPrompt: "",
    isRootAgent: false,
    toolIds: [],
    parentId: undefined,
    modelId: null,
    provider: null,
  });
  const [toolSearch, setToolSearch] = useState("");
  const [savingAgent, setSavingAgent] = useState(false);

  // Mapping Dialog State
  const [isMappingDialogOpen, setIsMappingDialogOpen] = useState(false);
  const [mappingForm, setMappingForm] = useState({
    channelType: "lark" as "lark" | "desktop",
    channelIdentifier: "",
    agentDefinitionId: "",
  });
  const [savingMapping, setSavingMapping] = useState(false);

  const selectedTab = useMemo<AgentsTab>(() => {
    const rawTab = searchParams.get("tab");
    return isAgentsTab(rawTab) ? rawTab : "agents";
  }, [searchParams]);

  const setTab = (tab: AgentsTab) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", tab);
    setSearchParams(next, { replace: true });
  };

  const loadAgents = async () => {
    if (!token) return;
    try {
      const data = await agentsApi.list<Agent>(token);
      setAgents(data);
    } catch (err) {
      console.error("Failed to load agents", err);
    }
  };

  const loadMappings = async () => {
    if (!token) return;
    try {
      const data = await channelMappingsApi.list<ChannelMapping>(token);
      setMappings(data);
    } catch (err) {
      console.error("Failed to load mappings", err);
    }
  };

  const loadRegistry = async () => {
    if (!token) return;
    setRegistryLoading(true);
    try {
      const data = await agentsApi.toolRegistry<ToolDefinition>(token);
      setTools(data);
    } catch (err) {
      console.error("Failed to load tool registry", err);
    } finally {
      setRegistryLoading(false);
    }
  };

  const loadModelCatalog = async () => {
    if (!token) return;
    setCatalogLoading(true);
    try {
      const data = await agentsApi.modelCatalog(token);
      setModelCatalog(data);
    } catch (err) {
      console.error("Failed to load model catalog", err);
    } finally {
      setCatalogLoading(false);
    }
  };

  const initData = async () => {
    setLoading(true);
    await Promise.all([loadAgents(), loadMappings()]);
    setLoading(false);
  };

  useEffect(() => {
    void initData();
  }, [token]);

  const handleToggleActive = async (agent: Agent) => {
    if (!token) return;
    try {
      await agentsApi.toggle(agent.id, token);
      toast({
        title: `Agent ${agent.isActive ? "disabled" : "enabled"}`,
        variant: "success",
      });
      await loadAgents();
    } catch (err) {
      // toast already handled by api.ts
    }
  };

  const handleDeleteAgent = async (agent: Agent) => {
    if (!token) return;
    const hasChildren = agents.some((a) => a.parentId === agent.id);
    if (hasChildren) {
      toast({
        title: "Cannot delete agent",
        description:
          "This agent has child agents linked to it. Remove children first.",
        variant: "destructive",
      });
      return;
    }

    if (!confirm(`Delete agent "${agent.name}"?`)) return;

    try {
      await agentsApi.delete(agent.id, token);
      toast({ title: "Agent deleted", variant: "success" });
      await loadAgents();
    } catch (err) {}
  };

  const openBuilder = (agent?: Agent) => {
    void loadRegistry();
    void loadModelCatalog();
    if (agent) {
      setEditingAgent(agent);
      setBuilderForm({
        name: agent.name,
        description: agent.description || "",
        systemPrompt: agent.systemPrompt,
        isRootAgent: agent.isRootAgent,
        toolIds: agent.toolIds,
        parentId: agent.parentId || undefined,
        modelId: agent.modelId || null,
        provider: agent.provider || null,
      });
    } else {
      setEditingAgent(null);
      setBuilderForm({
        name: "",
        description: "",
        systemPrompt: "",
        isRootAgent: false,
        toolIds: [],
        parentId: undefined,
        modelId: null,
        provider: null,
      });
    }
    setIsBuilderOpen(true);
  };

  const saveAgent = async () => {
    if (!token || !builderForm.name.trim()) return;
    setSavingAgent(true);
    try {
      const payload = {
        ...builderForm,
        modelId: builderForm.modelId || null,
        provider: builderForm.provider || null,
      };

      if (editingAgent) {
        const update: UpdateAgentInput = {
          ...payload,
          isActive: editingAgent.isActive,
          parentId: builderForm.parentId,
        };
        await agentsApi.update(editingAgent.id, update, token);
        toast({ title: "Agent updated", variant: "success" });
      } else {
        await agentsApi.create(payload, token);
        toast({ title: "Agent created", variant: "success" });
      }
      setIsBuilderOpen(false);
      await loadAgents();
    } catch (err) {
    } finally {
      setSavingAgent(false);
    }
  };

  const saveMapping = async () => {
    if (
      !token ||
      !mappingForm.channelIdentifier ||
      !mappingForm.agentDefinitionId
    )
      return;
    setSavingMapping(true);
    try {
      await channelMappingsApi.set(mappingForm, token);
      toast({ title: "Channel mapping saved", variant: "success" });
      setIsMappingDialogOpen(false);
      await loadMappings();
    } catch (err) {
    } finally {
      setSavingMapping(false);
    }
  };

  const removeMapping = async (mapping: ChannelMapping) => {
    if (!token || !confirm("Remove this channel mapping?")) return;
    try {
      await channelMappingsApi.remove(
        {
          channelType: mapping.channelType,
          channelIdentifier: mapping.channelIdentifier,
        },
        token,
      );
      toast({ title: "Mapping removed", variant: "success" });
      await loadMappings();
    } catch (err) {}
  };

  const filteredTools = useMemo(() => {
    const q = toolSearch.toLowerCase();
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    );
  }, [tools, toolSearch]);

  const autoInjectedPrompt = useMemo(() => {
    return tools
      .filter((t) => builderForm.toolIds?.includes(t.toolId))
      .map((t) => t.promptSnippet)
      .join("\n\n");
  }, [tools, builderForm.toolIds]);

  const toggleTool = (toolId: string) => {
    setBuilderForm((prev) => {
      const current = prev.toolIds || [];
      const next = current.includes(toolId)
        ? current.filter((id) => id !== toolId)
        : [...current, toolId];
      return { ...prev, toolIds: next };
    });
  };

  return (
    <div className="flex flex-col gap-8 w-full animate-in fade-in duration-700">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Bot className="h-6 w-6 text-primary" />
            Agents
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage dynamic agent definitions and their channel deployment
            mappings.
          </p>
        </div>
        {selectedTab === "agents" && (
          <Button
            onClick={() => openBuilder()}
            className="bg-primary text-primary-foreground font-bold uppercase tracking-widest text-[10px] h-9"
          >
            <Plus className="h-4 w-4 mr-2" />
            New Agent
          </Button>
        )}
        {selectedTab === "mappings" && (
          <Button
            onClick={() => setIsMappingDialogOpen(true)}
            className="bg-primary text-primary-foreground font-bold uppercase tracking-widest text-[10px] h-9"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Mapping
          </Button>
        )}
      </div>

      <Card className="bg-card border-border/50 shadow-sm overflow-hidden">
        <CardHeader className="border-b border-border/50 bg-secondary/5 px-6 py-4">
          <Tabs
            value={selectedTab}
            onValueChange={(v) => isAgentsTab(v) && setTab(v)}
            className="w-full"
          >
            <TabsList className="bg-transparent h-10 gap-6 border-none p-0">
              <TabsTrigger
                value="agents"
                className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-10 text-xs font-bold tracking-wider uppercase transition-all flex items-center gap-2"
              >
                <Bot className="h-3.5 w-3.5" />
                Agents
              </TabsTrigger>
              <TabsTrigger
                value="mappings"
                className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-10 text-xs font-bold tracking-wider uppercase transition-all flex items-center gap-2"
              >
                <Link2 className="h-3.5 w-3.5" />
                Channel Mappings
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="p-0">
          <div className="animate-in slide-in-from-bottom-2 duration-500">
            {selectedTab === "agents" ? (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30 border-b border-border/50 hover:bg-muted/30">
                    <TableHead className="text-[10px] font-bold uppercase tracking-widest">
                      Name
                    </TableHead>
                    <TableHead className="text-[10px] font-bold uppercase tracking-widest">
                      Description
                    </TableHead>
                    <TableHead className="text-[10px] font-bold uppercase tracking-widest">
                      Type
                    </TableHead>
                    <TableHead className="text-[10px] font-bold uppercase tracking-widest">
                      Tools
                    </TableHead>
                    <TableHead className="text-[10px] font-bold uppercase tracking-widest">
                      Model
                    </TableHead>
                    <TableHead className="text-[10px] font-bold uppercase tracking-widest">
                      Parent
                    </TableHead>
                    <TableHead className="text-[10px] font-bold uppercase tracking-widest">
                      Status
                    </TableHead>
                    <TableHead className="text-[10px] font-bold uppercase tracking-widest text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={8} className="p-8">
                        <Skeleton className="h-20 w-full" />
                      </TableCell>
                    </TableRow>
                  ) : agents.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={8}
                        className="p-12 text-center text-muted-foreground italic"
                      >
                        No agents defined yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    agents.map((agent) => (
                      <TableRow
                        key={agent.id}
                        className="border-b border-border/40 hover:bg-secondary/5 transition-colors"
                      >
                        <TableCell className="font-bold text-sm">
                          {agent.name}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground truncate max-w-[200px]">
                          {agent.description || "—"}
                        </TableCell>
                        <TableCell>
                          {agent.isRootAgent ? (
                            <Badge
                              variant="secondary"
                              className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-[9px] uppercase font-bold"
                            >
                              Root
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-[9px] uppercase font-bold text-muted-foreground"
                            >
                              Standard
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className="text-[10px] font-mono"
                          >
                            {agent.toolIds.length} Tools
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {agent.modelId ? (
                            <div className="flex items-center gap-1.5">
                              <Bot className="h-3 w-3 text-primary" />
                              <Badge
                                variant="outline"
                                className="text-[10px] font-mono bg-primary/5 text-primary border-primary/20"
                              >
                                {agent.modelId}
                              </Badge>
                            </div>
                          ) : (
                            <span className="text-[10px] text-muted-foreground italic">
                              Global Default
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-[11px] font-medium">
                          {agent.parentId
                            ? agents.find((a) => a.id === agent.parentId)
                                ?.name || "Unknown"
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleToggleActive(agent)}
                            className={cn(
                              "h-7 px-2 text-[10px] font-bold uppercase tracking-widest transition-all",
                              agent.isActive
                                ? "text-emerald-500 hover:text-emerald-600 hover:bg-emerald-500/10"
                                : "text-muted-foreground hover:bg-secondary/50",
                            )}
                          >
                            {agent.isActive ? (
                              <ToggleRight className="h-4 w-4 mr-1" />
                            ) : (
                              <ToggleLeft className="h-4 w-4 mr-1" />
                            )}
                            {agent.isActive ? "Active" : "Inactive"}
                          </Button>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-foreground"
                              onClick={() => openBuilder(agent)}
                            >
                              <Edit className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => handleDeleteAgent(agent)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30 border-b border-border/50 hover:bg-muted/30">
                    <TableHead className="text-[10px] font-bold uppercase tracking-widest">
                      Channel Type
                    </TableHead>
                    <TableHead className="text-[10px] font-bold uppercase tracking-widest">
                      Identifier
                    </TableHead>
                    <TableHead className="text-[10px] font-bold uppercase tracking-widest">
                      Mapped Agent
                    </TableHead>
                    <TableHead className="text-[10px] font-bold uppercase tracking-widest">
                      Status
                    </TableHead>
                    <TableHead className="text-[10px] font-bold uppercase tracking-widest text-right">
                      Remove
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={5} className="p-8">
                        <Skeleton className="h-20 w-full" />
                      </TableCell>
                    </TableRow>
                  ) : mappings.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="p-12 text-center text-muted-foreground italic"
                      >
                        No channel mappings configured.
                      </TableCell>
                    </TableRow>
                  ) : (
                    mappings.map((mapping, idx) => (
                      <TableRow
                        key={`${mapping.channelType}-${mapping.channelIdentifier}-${idx}`}
                        className="border-b border-border/40 hover:bg-secondary/5 transition-colors"
                      >
                        <TableCell>
                          <Badge
                            variant="outline"
                            className="text-[9px] uppercase font-bold bg-secondary/30"
                          >
                            {mapping.channelType}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {mapping.channelIdentifier}
                        </TableCell>
                        <TableCell className="font-bold text-sm">
                          {mapping.agentName ||
                            agents.find(
                              (a) => a.id === mapping.agentDefinitionId,
                            )?.name ||
                            mapping.agentDefinitionId}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 text-emerald-500 font-bold text-[10px] uppercase tracking-widest">
                            <CheckCircle2 className="h-3 w-3" />
                            Live
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={() => removeMapping(mapping)}
                          >
                            <Unlink className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Agent Builder Sheet */}
      <Sheet open={isBuilderOpen} onOpenChange={setIsBuilderOpen}>
        <SheetContent className="w-full sm:max-w-[600px] flex flex-col p-0 border-l border-border/40 bg-background/95 backdrop-blur-xl">
          <SheetHeader className="p-8 border-b border-border/40 bg-secondary/5">
            <SheetTitle className="text-xl font-bold tracking-tight">
              {editingAgent ? "Edit Agent" : "New Agent Builder"}
            </SheetTitle>
            <SheetDescription>
              Configure model personality, parent relationship, and available
              tool capabilities.
            </SheetDescription>
          </SheetHeader>

          <ScrollArea className="flex-1">
            <div className="p-8 space-y-8">
              <div className="grid gap-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground ml-1">
                    Agent Name
                  </label>
                  <Input
                    value={builderForm.name}
                    onChange={(e) =>
                      setBuilderForm((prev) => ({
                        ...prev,
                        name: e.target.value,
                      }))
                    }
                    placeholder="e.g. Senior Researcher"
                    className="h-11 bg-background border-border/50"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground ml-1">
                    Description
                  </label>
                  <Input
                    value={builderForm.description}
                    onChange={(e) =>
                      setBuilderForm((prev) => ({
                        ...prev,
                        description: e.target.value,
                      }))
                    }
                    placeholder="Briefly state this agent's core purpose"
                    className="h-11 bg-background border-border/50"
                  />
                </div>
                <div className="flex items-center gap-8 py-2">
                  <div className="flex items-center gap-3">
                    <Button
                      variant={builderForm.isRootAgent ? "default" : "outline"}
                      size="sm"
                      onClick={() =>
                        setBuilderForm((prev) => ({
                          ...prev,
                          isRootAgent: !prev.isRootAgent,
                        }))
                      }
                      className="h-8 text-[10px] font-bold uppercase tracking-widest"
                    >
                      {builderForm.isRootAgent ? (
                        <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
                      ) : (
                        <Shield className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      Root Agent
                    </Button>
                  </div>
                  <div className="flex-1 space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground ml-1">
                      Parent Agent
                    </label>
                    <Select
                      value={builderForm.parentId || "none"}
                      onValueChange={(v) =>
                        setBuilderForm((prev) => ({
                          ...prev,
                          parentId: v === "none" ? undefined : v,
                        }))
                      }
                    >
                      <SelectTrigger className="h-9 text-xs bg-background border-border/50">
                        <SelectValue placeholder="No Parent" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No Parent</SelectItem>
                        {agents
                          .filter((a) => a.id !== editingAgent?.id)
                          .map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <Separator className="bg-border/40" />

                <div className="space-y-4">
                  <div className="flex items-center justify-between ml-1">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                      <Terminal className="h-3.5 w-3.5" />
                      System Prompt
                    </label>
                    <span className="text-[10px] font-mono text-muted-foreground uppercase">
                      {builderForm.systemPrompt.length} chars
                    </span>
                  </div>
                  <Textarea
                    value={builderForm.systemPrompt}
                    onChange={(e) =>
                      setBuilderForm((prev) => ({
                        ...prev,
                        systemPrompt: e.target.value,
                      }))
                    }
                    rows={10}
                    className="bg-[#050505] border-border/50 text-emerald-500 font-mono text-sm leading-relaxed p-6 focus-visible:ring-emerald-500/20 resize-y rounded-xl shadow-inner"
                    placeholder="# You are a helpful assistant..."
                  />
                </div>

                <Separator className="bg-border/40" />

                <div className="space-y-6">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground ml-1">
                      Model Override
                    </label>
                    <p className="text-[10px] text-muted-foreground ml-1">
                      Leave unset to use the global default model
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground/70 ml-1">
                        Provider
                      </label>
                      <Select
                        value={builderForm.provider || "none"}
                        onValueChange={(v) => {
                          const provider = v === "none" ? null : v;
                          let modelId = null;
                          if (provider) {
                            const firstModel = modelCatalog.find(
                              (m) => m.provider === provider,
                            );
                            if (firstModel) modelId = firstModel.modelId;
                          }
                          setBuilderForm((prev) => ({
                            ...prev,
                            provider,
                            modelId,
                          }));
                        }}
                      >
                        <SelectTrigger className="h-9 text-xs bg-background border-border/50">
                          <SelectValue placeholder="Use Global Default" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">
                            Use Global Default
                          </SelectItem>
                          <SelectItem value="openai">OpenAI</SelectItem>
                          <SelectItem value="google">Google Gemini</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground/70 ml-1">
                        Model
                      </label>
                      <Select
                        disabled={!builderForm.provider}
                        value={builderForm.modelId || "none"}
                        onValueChange={(v) =>
                          setBuilderForm((prev) => ({
                            ...prev,
                            modelId: v === "none" ? null : v,
                          }))
                        }
                      >
                        <SelectTrigger className="h-9 text-xs bg-background border-border/50">
                          <SelectValue placeholder="Select a model" />
                        </SelectTrigger>
                        <SelectContent>
                          {modelCatalog
                            .filter((m) => m.provider === builderForm.provider)
                            .map((m) => (
                              <SelectItem key={m.modelId} value={m.modelId}>
                                <div className="flex items-center gap-2">
                                  <span>{m.label}</span>
                                  <Badge
                                    variant="outline"
                                    className="text-[8px] px-1 h-3.5 uppercase font-bold"
                                  >
                                    {m.speed}
                                  </Badge>
                                  <Badge
                                    variant="outline"
                                    className="text-[8px] px-1 h-3.5 uppercase font-bold"
                                  >
                                    {m.cost}
                                  </Badge>
                                </div>
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {builderForm.modelId && (
                    <Card className="bg-secondary/10 border-border/40 shadow-none overflow-hidden">
                      <CardContent className="p-4 space-y-3">
                        {modelCatalog
                          .filter((m) => m.modelId === builderForm.modelId)
                          .map((m) => (
                            <div key={m.modelId} className="space-y-3">
                              <div className="flex items-start justify-between">
                                <div className="space-y-1">
                                  <p className="text-xs font-bold">{m.label}</p>
                                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                                    {m.description}
                                  </p>
                                </div>
                                <div className="flex flex-col gap-1 items-end shrink-0">
                                  <Badge
                                    variant="secondary"
                                    className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-[8px] uppercase font-bold"
                                  >
                                    {m.speed}
                                  </Badge>
                                  <Badge
                                    variant="secondary"
                                    className="bg-amber-500/10 text-amber-500 border-amber-500/20 text-[8px] uppercase font-bold"
                                  >
                                    {m.cost}
                                  </Badge>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 pt-1 border-t border-border/20">
                                <Box className="h-3 w-3 text-muted-foreground" />
                                <span className="text-[10px] text-muted-foreground font-medium">
                                  Context Window:{" "}
                                  {m.maxContextTokens.toLocaleString()} tokens
                                </span>
                                {m.supportsThinking && (
                                  <Badge
                                    variant="outline"
                                    className="ml-auto text-[8px] uppercase font-bold bg-purple-500/5 text-purple-500 border-purple-500/10"
                                  >
                                    Thinking
                                  </Badge>
                                )}
                              </div>
                            </div>
                          ))}
                      </CardContent>
                    </Card>
                  )}
                </div>

                <Separator className="bg-border/40" />

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground ml-1">
                      Tool Capabilities
                    </label>
                    <div className="relative w-48">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50" />
                      <Input
                        value={toolSearch}
                        onChange={(e) => setToolSearch(e.target.value)}
                        placeholder="Filter tools..."
                        className="h-7 text-[11px] pl-7 bg-secondary/20 border-border/40"
                      />
                    </div>
                  </div>

                  <div className="grid gap-2">
                    {registryLoading ? (
                      <Skeleton className="h-20 w-full" />
                    ) : (
                      filteredTools.map((tool) => {
                        const isSelected = builderForm.toolIds?.includes(
                          tool.toolId,
                        );
                        const isDeprecated = tool.isDeprecated;
                        return (
                          <div
                            key={tool.toolId}
                            onClick={() =>
                              !isDeprecated && toggleTool(tool.toolId)
                            }
                            className={cn(
                              "group p-3 rounded-lg border transition-all cursor-pointer flex items-center justify-between gap-4",
                              isSelected
                                ? "bg-primary/5 border-primary/30"
                                : "border-border/30 hover:border-border/60",
                              isDeprecated
                                ? "opacity-40 grayscale pointer-events-none bg-muted/20"
                                : "",
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span
                                  className={cn(
                                    "text-xs font-bold",
                                    isSelected
                                      ? "text-primary"
                                      : "text-foreground",
                                  )}
                                >
                                  {tool.name}
                                </span>
                                <Badge
                                  variant="outline"
                                  className="text-[8px] h-3.5 uppercase font-bold px-1"
                                >
                                  {tool.category}
                                </Badge>
                                {isDeprecated && (
                                  <Badge
                                    variant="destructive"
                                    className="text-[8px] h-3.5 uppercase font-bold px-1"
                                  >
                                    Deprecated
                                  </Badge>
                                )}
                              </div>
                              <p className="text-[10px] text-muted-foreground mt-1 break-words leading-normal">
                                {tool.description}
                              </p>
                            </div>
                            <div
                              className={cn(
                                "h-5 w-5 rounded border flex items-center justify-center transition-colors shrink-0",
                                isSelected
                                  ? "bg-primary border-primary text-primary-foreground"
                                  : "border-border/60 group-hover:border-primary/50",
                              )}
                            >
                              {isSelected && (
                                <CheckCircle2 className="h-3 w-3" />
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          </ScrollArea>

          <SheetFooter className="p-8 border-t border-border/40 bg-secondary/5 shrink-0">
            <Button
              variant="ghost"
              onClick={() => setIsBuilderOpen(false)}
              className="text-[10px] font-bold uppercase tracking-widest h-10 px-6"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void saveAgent()}
              disabled={savingAgent || !builderForm.name.trim()}
              className="bg-primary text-primary-foreground font-bold uppercase tracking-widest text-[10px] h-10 px-8"
            >
              {savingAgent
                ? "Saving..."
                : editingAgent
                  ? "Update Agent"
                  : "Create Agent"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Add Mapping Dialog */}
      <Dialog open={isMappingDialogOpen} onOpenChange={setIsMappingDialogOpen}>
        <DialogContent className="sm:max-w-[420px] bg-background/95 backdrop-blur-xl border-border/40">
          <DialogHeader>
            <DialogTitle className="text-lg font-bold">
              New Channel Mapping
            </DialogTitle>
            <DialogDescription>
              Deploy a specific agent to a communication channel.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground ml-1">
                Channel Type
              </label>
              <Select
                value={mappingForm.channelType}
                onValueChange={(v) =>
                  setMappingForm((prev) => ({
                    ...prev,
                    channelType: v as "lark" | "desktop",
                  }))
                }
              >
                <SelectTrigger className="bg-secondary/20 border-border/40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lark">Lark (Messaging)</SelectItem>
                  <SelectItem value="desktop">Desktop App</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground ml-1">
                Channel Identifier
              </label>
              <Input
                value={mappingForm.channelIdentifier}
                onChange={(e) =>
                  setMappingForm((prev) => ({
                    ...prev,
                    channelIdentifier: e.target.value,
                  }))
                }
                placeholder="e.g. chat_id or *"
                className="bg-secondary/20 border-border/40"
              />
              <p className="text-[9px] text-muted-foreground font-medium ml-1">
                Use * to match all channels of this type
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground ml-1">
                Active Agent
              </label>
              <Select
                value={mappingForm.agentDefinitionId}
                onValueChange={(v) =>
                  setMappingForm((prev) => ({ ...prev, agentDefinitionId: v }))
                }
              >
                <SelectTrigger className="bg-secondary/20 border-border/40">
                  <SelectValue placeholder="Select an active agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents
                    .filter((a) => a.isActive)
                    .map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  {agents.filter((a) => a.isActive).length === 0 && (
                    <div className="p-4 text-center text-[10px] text-muted-foreground italic flex flex-col items-center gap-2">
                      <AlertCircle className="h-4 w-4" />
                      No active agents available. Enable an agent first.
                    </div>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setIsMappingDialogOpen(false)}
              className="text-[10px] font-bold uppercase tracking-widest h-9"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void saveMapping()}
              disabled={
                savingMapping ||
                !mappingForm.channelIdentifier ||
                !mappingForm.agentDefinitionId
              }
              className="bg-primary text-primary-foreground font-bold uppercase tracking-widest text-[10px] h-9 px-6"
            >
              {savingMapping ? "Saving..." : "Save Mapping"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
