import { useState, useEffect, useCallback, useRef } from "react";
import { Skeleton } from "./ui/Skeleton";
import {
  X,
  FileText,
  Image as ImageIcon,
  File,
  Clock,
  Shield,
  Trash2,
  Loader2,
  RotateCcw,
  Share2,
  Search,
  Upload,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useAuth } from "../context/AuthContext";

export type FileAssetRecord = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  cloudinaryUrl: string;
  ingestionStatus: string;
  ingestionError?: string | null;
  createdAt: string;
  accessPolicies: Array<{ aiRole: string }>;
  shareStatus?: string;
  shareSummary?: string;
  sharedCompanyWide?: boolean;
};

interface FilesDrawerProps {
  open: boolean;
  onClose: () => void;
  onReference: (file: FileAssetRecord) => void;
  referencedIds: Set<string>;
}

function FileTypeIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/"))
    return <ImageIcon size={14} className="text-primary/60" />;
  if (mimeType === "application/pdf")
    return <FileText size={14} className="text-red-500/50" />;
  return <File size={14} className="text-muted-foreground/60" />;
}

function ingestionLabel(status: string) {
  if (status === "done") return { text: "Indexed", cls: "text-emerald-500/60" };
  if (status === "processing")
    return { text: "Processing...", cls: "text-amber-500/60" };
  if (status === "failed") return { text: "Failed", cls: "text-red-500/80" };
  return { text: "Pending", cls: "text-muted-foreground/40" };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function shareLabel(status?: string, sharedCompanyWide?: boolean) {
  if (sharedCompanyWide) return { text: "Shared", cls: "text-emerald-500/60" };
  if (status === "pending")
    return { text: "Pending approval", cls: "text-amber-500/60" };
  if (status === "delivery_failed")
    return { text: "Delivery failed", cls: "text-orange-500/60" };
  if (status === "reverted")
    return { text: "Reverted", cls: "text-muted-foreground/40" };
  return null;
}

export function FilesDrawer({
  open,
  onClose,
  onReference,
  referencedIds,
}: FilesDrawerProps) {
  const { token } = useAuth();
  const [files, setFiles] = useState<FileAssetRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const [sharingIds, setSharingIds] = useState<Set<string>>(new Set());
  const [canShare, setCanShare] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = e.target.files;
      if (!selectedFiles || selectedFiles.length === 0 || !token) return;

      setUploading(true);
      setStatusMessage("Uploading...");
      try {
        for (const file of Array.from(selectedFiles)) {
          const arrayBuffer = await file.arrayBuffer();
          await window.desktopAPI.files.upload(
            token,
            arrayBuffer,
            file.name,
            file.type || "application/octet-stream",
          );
        }
        setStatusMessage("Upload successful.");
        await loadFiles();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        setStatusMessage(msg);
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
        setTimeout(() => setStatusMessage(null), 3000);
      }
    },
    [token],
  );

  const loadFiles = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const result = await window.desktopAPI.files.list(token);
      if (result.success) {
        const payload = result.data as {
          data?: { files?: FileAssetRecord[]; canShare?: boolean };
        };
        setFiles(payload?.data?.files ?? []);
        setCanShare(Boolean(payload?.data?.canShare));
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (open) loadFiles();
  }, [open, loadFiles]);

  useEffect(() => {
    if (!open) return undefined;
    const hasInFlightFiles = files.some(
      (file) =>
        file.ingestionStatus === "pending" ||
        file.ingestionStatus === "processing",
    );
    if (!hasInFlightFiles) return undefined;

    const interval = window.setInterval(() => {
      void loadFiles();
    }, 2500);

    return () => window.clearInterval(interval);
  }, [files, loadFiles, open]);

  const handleDelete = useCallback(
    async (e: React.MouseEvent, fileId: string) => {
      e.stopPropagation();
      if (!token) return;

      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.add(fileId);
        return next;
      });

      try {
        const result = await window.desktopAPI.files.delete(token, fileId);
        if (result.success) {
          setFiles((prev) => prev.filter((f) => f.id !== fileId));
        }
      } finally {
        setDeletingIds((prev) => {
          const next = new Set(prev);
          next.delete(fileId);
          return next;
        });
      }
    },
    [token],
  );

  const handleRetry = useCallback(
    async (e: React.MouseEvent, fileId: string) => {
      e.stopPropagation();
      if (!token) return;

      setRetryingIds((prev) => {
        const next = new Set(prev);
        next.add(fileId);
        return next;
      });

      try {
        const result = await window.desktopAPI.files.retry(token, fileId);
        if (result.success) {
          setFiles((prev) =>
            prev.map((f) =>
              f.id === fileId
                ? { ...f, ingestionStatus: "pending", ingestionError: null }
                : f,
            ),
          );
        }
      } finally {
        setRetryingIds((prev) => {
          const next = new Set(prev);
          next.delete(fileId);
          return next;
        });
      }
    },
    [token],
  );

  const handleShare = useCallback(
    async (e: React.MouseEvent, fileId: string) => {
      e.stopPropagation();
      if (!token) return;

      setStatusMessage(null);
      setSharingIds((prev) => {
        const next = new Set(prev);
        next.add(fileId);
        return next;
      });

      try {
        const result = await window.desktopAPI.files.share(token, fileId);
        const payload = result.data as {
          message?: string;
          data?: { status?: string; classification?: string };
        };
        if (result.success) {
          const status = payload?.data?.status ?? "processed";
          const classification = payload?.data?.classification;
          setStatusMessage(
            classification
              ? `Share ${status.replace(/_/g, " ")} (${classification}).`
              : `Share ${status.replace(/_/g, " ")}.`,
          );
        } else {
          setStatusMessage(payload?.message ?? "Failed to share file.");
        }
        void loadFiles();
      } finally {
        setSharingIds((prev) => {
          const next = new Set(prev);
          next.delete(fileId);
          return next;
        });
      }
    },
    [loadFiles, token],
  );

  const filtered = files.filter((f) =>
    f.fileName.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm animate-in fade-in duration-300"
          onClick={onClose}
        />
      )}

      {/* Drawer Panel */}
      <div
        className={cn(
          "fixed left-1/2 bottom-[84px] z-50 w-full max-w-[760px] -translate-x-1/2 transition-all duration-300 ease-out flex flex-col",
          open
            ? "opacity-100 translate-y-0 scale-100"
            : "opacity-0 translate-y-8 scale-[0.98] pointer-events-none",
          "rounded-2xl border border-border bg-background shadow-xl",
        )}
        style={{ maxHeight: "min(480px, 70vh)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
          <div className="flex flex-col">
            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-primary/80">
              Files
            </span>
            <span className="text-[13px] font-bold text-foreground/90">
              Asset Library
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="file"
              multiple
              ref={fileInputRef}
              onChange={handleFileSelect}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-secondary/50 px-3 text-[11px] font-bold text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {uploading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Upload size={12} />
              )}
              {uploading ? "UPLOADING..." : "UPLOAD"}
            </button>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-5 py-4">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/40"
            />
            <input
              type="text"
              placeholder="Search library..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={cn(
                "w-full rounded-xl pl-10 pr-4 h-10 text-[13px] outline-none transition-all leading-relaxed",
                "bg-black/20 text-foreground/90 placeholder:text-muted-foreground/30",
                "border border-border/50 focus:border-primary/30 shadow-sm",
              )}
            />
          </div>
        </div>

        {statusMessage && (
          <div className="mx-5 mb-4 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-[12px] font-medium text-primary/80 animate-in slide-in-from-top-2">
            {statusMessage}
          </div>
        )}

        {/* File list */}
        <div className="overflow-y-auto flex-1 px-5 pb-5 space-y-1">
          {loading && (
            <div className="space-y-4 py-2">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-4 px-3 py-2 border border-transparent"
                >
                  <Skeleton className="h-10 w-10 rounded-xl shrink-0 opacity-20" />
                  <div className="flex-1 space-y-2 opacity-20">
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="h-12 w-12 rounded-2xl bg-secondary/20 flex items-center justify-center text-muted-foreground/20 mb-4 border border-border/50">
                <FileText size={24} />
              </div>
              <span className="text-[13px] font-bold text-muted-foreground/40">
                {files.length === 0
                  ? "No files uploaded yet"
                  : "No files match your search"}
              </span>
            </div>
          )}

          {filtered.map((file) => {
            const isReferenced = referencedIds.has(file.id);
            const label = ingestionLabel(file.ingestionStatus);
            const share = shareLabel(file.shareStatus, file.sharedCompanyWide);
            const canTriggerShare =
              canShare &&
              file.ingestionStatus === "done" &&
              !file.sharedCompanyWide &&
              file.shareStatus !== "pending";
            return (
              <div
                key={file.id}
                className={cn(
                  "group flex items-center gap-4 rounded-xl px-3 py-2.5 cursor-pointer transition-all border shadow-sm",
                  isReferenced
                    ? "border-primary/20 bg-primary/5"
                    : "border-transparent hover:bg-secondary/30 hover:border-border/50",
                )}
                onClick={() => onReference(file)}
              >
                <div className="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center bg-black/20 border border-border/50 text-muted-foreground overflow-hidden shadow-sm">
                  {file.mimeType.startsWith("image/") && file.cloudinaryUrl ? (
                    <img
                      src={file.cloudinaryUrl}
                      alt={file.fileName}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <FileTypeIcon mimeType={file.mimeType} />
                  )}
                </div>

                <div className="flex-1 min-w-0 flex flex-col">
                  <p className="text-[13px] font-bold text-foreground/90 truncate">
                    {file.fileName}
                  </p>
                  <div className="flex items-center gap-2 mt-1 whitespace-nowrap overflow-hidden text-[11px] font-medium text-muted-foreground/50">
                    <span className={cn("font-bold", label.cls)}>
                      {label.text}
                    </span>
                    <span className="opacity-30">·</span>
                    <span>{formatBytes(file.sizeBytes)}</span>
                    <span className="opacity-30">·</span>
                    <span className="flex items-center gap-1">
                      <Clock size={10} className="opacity-60" />{" "}
                      {formatDate(file.createdAt)}
                    </span>
                  </div>

                  {(file.accessPolicies.length > 0 || share) && (
                    <div className="flex items-center gap-2 mt-1.5">
                      {file.accessPolicies.map((p, idx) => (
                        <span
                          key={idx}
                          className="bg-primary/10 border border-primary/20 text-[10px] font-bold text-primary/70 px-1.5 py-0.5 rounded-lg truncate"
                        >
                          {p.aiRole}
                        </span>
                      ))}
                      {share && (
                        <div className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-500/60 ml-1">
                          <Share2 size={10} />
                          <span>{share.text}</span>
                        </div>
                      )}
                    </div>
                  )}
                  {file.ingestionStatus === "failed" && file.ingestionError && (
                    <div
                      className="mt-1.5 max-w-full truncate text-[11px] font-semibold text-red-500/85"
                      title={file.ingestionError}
                    >
                      {file.ingestionError}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 ml-2">
                  {isReferenced ? (
                    <div className="text-[10px] font-black uppercase tracking-widest text-primary/80 bg-primary/10 px-2 py-1 rounded-lg">
                      Referenced
                    </div>
                  ) : (
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] font-black uppercase tracking-widest text-muted-foreground/40 px-2 py-1">
                      Click to add
                    </div>
                  )}

                  <div className="flex items-center gap-1 border-l border-border/50 ml-2 pl-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    {file.ingestionStatus === "failed" && (
                      <button
                        onClick={(e) => void handleRetry(e, file.id)}
                        disabled={retryingIds.has(file.id)}
                        className="p-1.5 rounded-lg bg-secondary/50 text-muted-foreground hover:text-primary transition-all shadow-sm"
                        title="Retry Indexing"
                      >
                        {retryingIds.has(file.id) ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <RotateCcw size={14} />
                        )}
                      </button>
                    )}

                    {canTriggerShare && (
                      <button
                        onClick={(e) => void handleShare(e, file.id)}
                        disabled={sharingIds.has(file.id)}
                        className="p-1.5 rounded-lg bg-secondary/50 text-muted-foreground hover:text-emerald-500 transition-all shadow-sm"
                        title="Share to Knowledge Base"
                      >
                        {sharingIds.has(file.id) ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Share2 size={14} />
                        )}
                      </button>
                    )}

                    <button
                      onClick={(e) => void handleDelete(e, file.id)}
                      disabled={deletingIds.has(file.id)}
                      className="p-1.5 rounded-lg bg-secondary/50 text-muted-foreground hover:text-red-500 transition-all shadow-sm"
                      title="Delete File"
                    >
                      {deletingIds.has(file.id) ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Trash2 size={14} />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
