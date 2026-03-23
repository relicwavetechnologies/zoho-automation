import { useEffect, useMemo, useState } from "react";
import {
  Database,
  FileSearch,
  FlaskConical,
  Layers3,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";

import { useAdminAuth } from "../auth/AdminAuthProvider";
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
import { ScrollArea } from "../components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import { api } from "../lib/api";
import { cn } from "../lib/utils";

type RagFileListItem = {
  fileAssetId: string;
  fileName: string;
  mimeType: string;
  ingestionStatus: string;
  ingestionError?: string;
  createdAt: string;
  updatedAt: string;
  documentClass: string;
  chunkingStrategy: string;
  hierarchical: boolean;
  chunkCount: number;
  allowedRoles: string[];
};

type RagFileDiagnostics = {
  file: {
    fileAssetId: string;
    companyId: string;
    fileName: string;
    mimeType: string;
    cloudinaryUrl?: string | null;
    ingestionStatus: string;
    ingestionError?: string | null;
    createdAt: string;
    updatedAt: string;
  };
  diagnostics: {
    chunkCount: number;
    documentClass: string;
    chunkingStrategy: string;
    hierarchical: boolean;
    contextualEnrichment: boolean;
    allowedRoles: string[];
  };
  chunks: Array<{
    id: string;
    chunkIndex: number;
    rawChunkText?: string;
    indexedChunkText?: string;
    sectionPath: string[];
    parentSectionId?: string;
    parentSectionText?: string;
    contextPrefix?: string;
    contextualEnrichmentApplied?: boolean;
  }>;
};

type RagReplayResult = {
  file?: {
    fileAssetId: string;
    fileName: string;
    mimeType: string;
    ingestionStatus: string;
  };
  planner: {
    knowledgeNeeds?: string[];
    preferredStrategy?: string;
    rationale: string[];
    steps: Array<{
      need: string;
      strategy: string;
      required: boolean;
      topK?: number;
      freshness?: string;
    }>;
  };
  orchestrator: {
    toolFamilies: string[];
    systemDirectives: string[];
  };
  retrieval: {
    matches: Array<{
      id: string;
      fileName: string;
      text: string;
      displayText: string;
      modality: string;
      url?: string;
      score?: number;
      sourceId?: string;
      chunkIndex?: number;
      documentClass?: string;
      chunkingStrategy?: string;
      sectionPath?: string[];
      parentSectionId?: string;
      parentSectionText?: string;
    }>;
    citations: Array<Record<string, unknown>>;
    enhancements: string[];
    queriesUsed: string[];
    correctiveRetryUsed: boolean;
  };
  metrics: {
    durationMs: number;
    matchCount: number;
    citationCount: number;
    enhancements: string[];
    correctiveRetryUsed: boolean;
  };
};

type TestScenario = {
  id: string;
  title: string;
  query: string;
  expected: string;
  category: "rag" | "chunking";
};

const TEST_SCENARIOS: TestScenario[] = [
  {
    id: "crm-current",
    title: "CRM live confirmation",
    query: "What is the current stage and owner for deal Acme renewal today?",
    expected: "Expect crm_entity with zoho_vector_plus_live.",
    category: "rag",
  },
  {
    id: "docs-policy",
    title: "Policy broad search",
    query: "What does our leave policy say about carryover?",
    expected:
      "Expect company_docs with chunk search and parent section context.",
    category: "rag",
  },
  {
    id: "docs-exact",
    title: "Contract exact wording",
    query: "Quote the exact termination notice clause from this contract.",
    expected: "Expect doc_full_read escalation from a file hit.",
    category: "rag",
  },
  {
    id: "workflow-skill",
    title: "Workflow skill lookup",
    query: "How do we onboard a new vendor in our process?",
    expected: "Expect workflow_skill with skill_db_search first.",
    category: "rag",
  },
  {
    id: "hybrid-web",
    title: "Hybrid internal plus web",
    query: "Compare our refund policy with the latest public regulation.",
    expected: "Expect hybrid_web with internal retrieval before web.",
    category: "rag",
  },
  {
    id: "structured-finance",
    title: "Structured parser-first",
    query: "What is the total due and vendor name on this invoice?",
    expected: "Expect structured_finance and parser-first retrieval.",
    category: "rag",
  },
  {
    id: "chunk-policy",
    title: "Policy chunking check",
    query:
      "Check that policy documents preserve section hierarchy and parent context.",
    expected:
      "Upload a policy PDF and verify sectionPath and parentSectionText.",
    category: "chunking",
  },
  {
    id: "chunk-generic",
    title: "Generic text chunking check",
    query:
      "Check that a generic note uses semantic heading chunking without parent sections.",
    expected:
      "Upload a markdown guide and inspect chunkingStrategy and section grouping.",
    category: "chunking",
  },
];

const formatTimestamp = (value?: string | null) => {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const formatNumber = (value?: number | null) => {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  return new Intl.NumberFormat().format(value);
};

const summarizeJson = (value: unknown) => JSON.stringify(value, null, 2);

export const RagDiagnosticsPage = () => {
  const { token, session } = useAdminAuth();
  const isSuperAdmin = session?.role === "SUPER_ADMIN";

  const [workspaceId, setWorkspaceId] = useState("");
  const scopedCompanyId = useMemo(
    () => (isSuperAdmin ? workspaceId.trim() : undefined),
    [isSuperAdmin, workspaceId],
  );
  const requiresWorkspaceSelection = isSuperAdmin && !scopedCompanyId;

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "completed" | "processing" | "failed"
  >("all");
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [replayQuery, setReplayQuery] = useState(
    TEST_SCENARIOS[0]?.query ?? "",
  );
  const [preferParentContext, setPreferParentContext] = useState(true);

  const [filesLoading, setFilesLoading] = useState(true);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);

  const [files, setFiles] = useState<RagFileListItem[]>([]);
  const [diagnostics, setDiagnostics] = useState<RagFileDiagnostics | null>(
    null,
  );
  const [replayResult, setReplayResult] = useState<RagReplayResult | null>(
    null,
  );

  const buildQuery = (parts: Array<[string, string | undefined]>) => {
    const query = new URLSearchParams();
    for (const [key, value] of parts) {
      if (value) query.set(key, value);
    }
    const encoded = query.toString();
    return encoded ? `?${encoded}` : "";
  };

  const loadFiles = async (options?: { preserveSelection?: boolean }) => {
    if (!token) return;
    if (requiresWorkspaceSelection) {
      setFiles([]);
      setSelectedFileId(null);
      setDiagnostics(null);
      setFilesLoading(false);
      return;
    }

    setFilesLoading(true);
    try {
      const rows = await api.get<RagFileListItem[]>(
        `/api/admin/company/rag/files${buildQuery([
          ["companyId", scopedCompanyId],
          ["query", search.trim() || undefined],
          [
            "ingestionStatus",
            statusFilter !== "all" ? statusFilter : undefined,
          ],
          ["limit", "40"],
        ])}`,
        token,
      );
      setFiles(rows);
      setSelectedFileId((current) => {
        if (
          options?.preserveSelection &&
          current &&
          rows.some((row) => row.fileAssetId === current)
        ) {
          return current;
        }
        return rows[0]?.fileAssetId ?? null;
      });
    } finally {
      setFilesLoading(false);
    }
  };

  const loadDiagnostics = async (fileAssetId: string) => {
    if (!token) return;
    setDiagnosticsLoading(true);
    try {
      const result = await api.get<RagFileDiagnostics>(
        `/api/admin/company/rag/files/${fileAssetId}${buildQuery([["companyId", scopedCompanyId]])}`,
        token,
      );
      setDiagnostics(result);
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  const runReplay = async () => {
    if (!token || requiresWorkspaceSelection || !replayQuery.trim()) return;
    setReplayLoading(true);
    try {
      const result = await api.post<RagReplayResult>(
        "/api/admin/company/rag/replay",
        {
          companyId: scopedCompanyId,
          query: replayQuery.trim(),
          fileAssetId: selectedFileId ?? undefined,
          preferParentContext,
          limit: 8,
        },
        token,
      );
      setReplayResult(result);
    } finally {
      setReplayLoading(false);
    }
  };

  useEffect(() => {
    void loadFiles();
  }, [token, scopedCompanyId, requiresWorkspaceSelection, statusFilter]);

  useEffect(() => {
    if (!selectedFileId) {
      setDiagnostics(null);
      return;
    }
    void loadDiagnostics(selectedFileId);
  }, [token, selectedFileId, scopedCompanyId]);

  const selectedFile = useMemo(
    () => files.find((file) => file.fileAssetId === selectedFileId) ?? null,
    [files, selectedFileId],
  );

  return (
    <div className="space-y-6">
      <Card className="border-border/50 bg-card/80 shadow-sm">
        <CardHeader className="space-y-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Layers3 className="h-5 w-5 text-primary" />
            RAG Diagnostics
          </CardTitle>
          <CardDescription>
            Inspect document chunking, replay retrieval planning, and validate
            each RAG lane from one admin view.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_220px_180px_auto]">
            {isSuperAdmin ? (
              <Input
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
                placeholder="Workspace / company ID"
              />
            ) : null}
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search files by name or mime type"
            />
            <Select
              value={statusFilter}
              onValueChange={(value) =>
                setStatusFilter(value as typeof statusFilter)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Filter ingestion status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="processing">Processing</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadFiles({ preserveSelection: true })}
              disabled={filesLoading || requiresWorkspaceSelection}
              className="gap-2"
            >
              <RefreshCw
                className={cn("h-4 w-4", filesLoading ? "animate-spin" : "")}
              />
              Refresh
            </Button>
          </div>
          {requiresWorkspaceSelection ? (
            <div className="rounded-lg border border-dashed border-border/70 bg-secondary/20 p-4 text-sm text-muted-foreground">
              Enter a workspace/company ID to inspect that tenant’s indexed
              files and retrieval traces.
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card className="border-border/50 bg-card/80 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4 text-primary" />
              Indexed Files
            </CardTitle>
            <CardDescription>
              Choose a file to inspect its chunking strategy and stored chunk
              metadata.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[720px]">
              <div className="space-y-2 p-4">
                {filesLoading ? (
                  Array.from({ length: 5 }).map((_, index) => (
                    <Skeleton key={index} className="h-24 w-full" />
                  ))
                ) : files.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                    No indexed files matched the current filters.
                  </div>
                ) : (
                  files.map((file) => (
                    <button
                      key={file.fileAssetId}
                      type="button"
                      onClick={() => setSelectedFileId(file.fileAssetId)}
                      className={cn(
                        "w-full rounded-xl border p-4 text-left transition-colors",
                        selectedFileId === file.fileAssetId
                          ? "border-primary/60 bg-primary/5"
                          : "border-border/50 hover:bg-secondary/10",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-foreground">
                            {file.fileName}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {file.mimeType}
                          </div>
                        </div>
                        <Badge
                          variant={
                            file.ingestionStatus === "completed"
                              ? "default"
                              : "secondary"
                          }
                        >
                          {file.ingestionStatus}
                        </Badge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Badge variant="outline">{file.documentClass}</Badge>
                        <Badge variant="outline">{file.chunkingStrategy}</Badge>
                        {file.hierarchical ? (
                          <Badge variant="outline">hierarchical</Badge>
                        ) : null}
                      </div>
                      <div className="mt-3 text-xs text-muted-foreground">
                        {formatNumber(file.chunkCount)} chunks · updated{" "}
                        {formatTimestamp(file.updatedAt)}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="border-border/50 bg-card/80 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileSearch className="h-4 w-4 text-primary" />
                File Inspector
              </CardTitle>
              <CardDescription>
                {selectedFile
                  ? `Chunk metadata for ${selectedFile.fileName}`
                  : "Select a file to inspect its chunks."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {diagnosticsLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-72 w-full" />
                </div>
              ) : diagnostics ? (
                <>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-lg border border-border/50 p-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Document Class
                      </div>
                      <div className="mt-1 font-medium">
                        {diagnostics.diagnostics.documentClass}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/50 p-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Chunking
                      </div>
                      <div className="mt-1 font-medium">
                        {diagnostics.diagnostics.chunkingStrategy}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/50 p-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Hierarchy
                      </div>
                      <div className="mt-1 font-medium">
                        {diagnostics.diagnostics.hierarchical
                          ? "Enabled"
                          : "Flat"}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/50 p-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Chunk Count
                      </div>
                      <div className="mt-1 font-medium">
                        {formatNumber(diagnostics.diagnostics.chunkCount)}
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-lg border border-border/50 p-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Contextual Enrichment
                      </div>
                      <div className="mt-1 font-medium">
                        {diagnostics.diagnostics.contextualEnrichment
                          ? "Enabled"
                          : "Disabled"}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/50 p-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Allowed Roles
                      </div>
                      <div className="mt-1 font-medium">
                        {diagnostics.diagnostics.allowedRoles.length > 0
                          ? diagnostics.diagnostics.allowedRoles.join(", ")
                          : "none"}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/50 p-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Updated
                      </div>
                      <div className="mt-1 font-medium">
                        {formatTimestamp(diagnostics.file.updatedAt)}
                      </div>
                    </div>
                  </div>

                  {diagnostics.file.ingestionError ? (
                    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
                      {diagnostics.file.ingestionError}
                    </div>
                  ) : null}

                  <div className="rounded-lg border border-border/50">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-16">#</TableHead>
                          <TableHead className="w-[180px]">Section</TableHead>
                          <TableHead>Raw Chunk</TableHead>
                          <TableHead>Indexed Chunk</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {diagnostics.chunks.map((chunk) => (
                          <TableRow key={chunk.id} className="align-top">
                            <TableCell className="text-xs text-muted-foreground">
                              {chunk.chunkIndex}
                            </TableCell>
                            <TableCell className="space-y-2 text-xs">
                              <div>
                                {chunk.sectionPath.join(" / ") || "n/a"}
                              </div>
                              {chunk.parentSectionId ? (
                                <Badge variant="outline" className="max-w-full">
                                  {chunk.parentSectionId}
                                </Badge>
                              ) : null}
                              {chunk.contextualEnrichmentApplied ? (
                                <Badge variant="secondary">
                                  contextualized
                                </Badge>
                              ) : null}
                            </TableCell>
                            <TableCell className="max-w-[320px] text-xs text-muted-foreground">
                              <div className="line-clamp-8 whitespace-pre-wrap">
                                {chunk.rawChunkText || "n/a"}
                              </div>
                              {chunk.parentSectionText ? (
                                <>
                                  <Separator className="my-2" />
                                  <div className="line-clamp-6 whitespace-pre-wrap text-[11px]">
                                    Parent: {chunk.parentSectionText}
                                  </div>
                                </>
                              ) : null}
                            </TableCell>
                            <TableCell className="max-w-[320px] text-xs text-muted-foreground">
                              <div className="line-clamp-8 whitespace-pre-wrap">
                                {chunk.indexedChunkText || "n/a"}
                              </div>
                              {chunk.contextPrefix ? (
                                <>
                                  <Separator className="my-2" />
                                  <div className="line-clamp-4 whitespace-pre-wrap text-[11px]">
                                    Context: {chunk.contextPrefix}
                                  </div>
                                </>
                              ) : null}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              ) : (
                <div className="rounded-lg border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                  Select a file from the left column to inspect its indexed
                  chunks.
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/80 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-primary" />
                Retrieval Replay
              </CardTitle>
              <CardDescription>
                Run a query through the planner and file retrieval layer to
                inspect selected RAG methods and enhancements.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_auto]">
                <Textarea
                  value={replayQuery}
                  onChange={(event) => setReplayQuery(event.target.value)}
                  rows={4}
                  placeholder="Enter a query to replay through the retrieval planner"
                />
                <div className="space-y-3">
                  <Select
                    value={selectedFileId ?? "all"}
                    onValueChange={(value) =>
                      setSelectedFileId(value === "all" ? null : value)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Optional file scope" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All files</SelectItem>
                      {files.map((file) => (
                        <SelectItem
                          key={file.fileAssetId}
                          value={file.fileAssetId}
                        >
                          {file.fileName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant={preferParentContext ? "default" : "outline"}
                    onClick={() => setPreferParentContext((value) => !value)}
                    className="w-full"
                  >
                    {preferParentContext
                      ? "Parent context on"
                      : "Parent context off"}
                  </Button>
                </div>
                <Button
                  type="button"
                  onClick={() => void runReplay()}
                  disabled={replayLoading || !replayQuery.trim()}
                >
                  {replayLoading ? (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="mr-2 h-4 w-4" />
                  )}
                  Replay
                </Button>
              </div>

              {replayResult ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="space-y-4">
                    <div className="rounded-lg border border-border/50 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Planner
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {(replayResult.planner.knowledgeNeeds ?? []).map(
                          (need) => (
                            <Badge key={need} variant="outline">
                              {need}
                            </Badge>
                          ),
                        )}
                        {replayResult.planner.preferredStrategy ? (
                          <Badge variant="secondary">
                            {replayResult.planner.preferredStrategy}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                        {replayResult.planner.rationale.map((line, index) => (
                          <div key={index}>{line}</div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-lg border border-border/50 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Planned Steps
                      </div>
                      <div className="mt-3 space-y-2">
                        {replayResult.planner.steps.map((step, index) => (
                          <div
                            key={`${step.need}-${step.strategy}-${index}`}
                            className="rounded-md bg-secondary/20 p-3 text-sm"
                          >
                            <div className="font-medium text-foreground">
                              {step.need} {"->"} {step.strategy}
                            </div>
                            <div className="mt-1 text-muted-foreground">
                              {" "}
                              {step.required ? "required" : "optional"}
                              {step.topK ? ` · topK ${step.topK}` : ""}
                              {step.freshness
                                ? ` · freshness ${step.freshness}`
                                : ""}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-lg border border-border/50 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Orchestrator
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {replayResult.orchestrator.toolFamilies.map(
                          (family) => (
                            <Badge key={family} variant="outline">
                              {family}
                            </Badge>
                          ),
                        )}
                      </div>
                      <pre className="mt-3 overflow-x-auto rounded-md bg-secondary/20 p-3 text-xs text-muted-foreground">
                        {summarizeJson(
                          replayResult.orchestrator.systemDirectives,
                        )}
                      </pre>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-lg border border-border/50 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Retrieval Execution
                      </div>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <div>
                          <div className="text-xs text-muted-foreground">
                            Enhancements
                          </div>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {replayResult.retrieval.enhancements.length > 0 ? (
                              replayResult.retrieval.enhancements.map(
                                (enhancement) => (
                                  <Badge key={enhancement} variant="secondary">
                                    {enhancement}
                                  </Badge>
                                ),
                              )
                            ) : (
                              <Badge variant="outline">none</Badge>
                            )}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">
                            Corrective Retry
                          </div>
                          <div className="mt-1 font-medium">
                            {replayResult.retrieval.correctiveRetryUsed
                              ? "Used"
                              : "Not used"}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">
                            Duration
                          </div>
                          <div className="mt-1 text-sm">
                            {formatNumber(replayResult.metrics.durationMs)} ms
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">
                            Matches
                          </div>
                          <div className="mt-1 font-medium">
                            {formatNumber(replayResult.metrics.matchCount)}
                          </div>
                        </div>
                      </div>
                      <pre className="mt-3 overflow-x-auto rounded-md bg-secondary/20 p-3 text-xs text-muted-foreground">
                        {summarizeJson(replayResult.retrieval.queriesUsed)}
                      </pre>
                    </div>

                    <div className="rounded-lg border border-border/50 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Retrieved Matches
                      </div>
                      <div className="mt-3 space-y-3">
                        {replayResult.retrieval.matches.length > 0 ? (
                          replayResult.retrieval.matches.map((item, index) => (
                            <div
                              key={`${item.id}-${index}`}
                              className="rounded-md bg-secondary/20 p-3"
                            >
                              <div className="text-sm font-medium text-foreground">
                                {item.fileName}
                              </div>
                              <div className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                                {item.displayText || item.text}
                              </div>
                              <div className="mt-2 text-xs text-muted-foreground">
                                score {item.score ?? "n/a"}
                                {typeof item.chunkIndex === "number"
                                  ? ` · chunk ${item.chunkIndex}`
                                  : ""}
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="text-sm text-muted-foreground">
                            No retrieval matches were returned for this replay.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                  Run a replay to inspect planner decisions, retrieval
                  enhancements, and grounded evidence.
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/80 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FlaskConical className="h-4 w-4 text-primary" />
                Test Matrix
              </CardTitle>
              <CardDescription>
                Use these scenarios to validate each chunking strategy and RAG
                lane end to end.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 lg:grid-cols-2">
              {TEST_SCENARIOS.map((scenario) => (
                <div
                  key={scenario.id}
                  className="rounded-xl border border-border/50 p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">{scenario.title}</div>
                    <Badge variant="outline">{scenario.category}</Badge>
                  </div>
                  <div className="mt-2 text-sm text-muted-foreground">
                    {scenario.expected}
                  </div>
                  <pre className="mt-3 overflow-x-auto rounded-md bg-secondary/20 p-3 text-xs text-muted-foreground">
                    {scenario.query}
                  </pre>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => setReplayQuery(scenario.query)}
                  >
                    Use query
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};
