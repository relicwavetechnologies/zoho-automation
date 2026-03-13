import { useEffect, useMemo, useState } from 'react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { api } from '../lib/api';

type ShareRequest = {
    id: string;
    companyId: string;
    requesterUserId: string;
    conversationKey: string;
    targetType?: 'conversation' | 'file_asset';
    fileAssetId?: string;
    fileName?: string;
    summary?: string;
    snapshotAt?: string;
    classification?: 'safe' | 'review' | 'critical';
    confidence?: number;
    reasons?: string[];
    riskFlags?: string[];
    delivery?: {
        recipientCount: number;
        successCount: number;
        failedCount: number;
        mode: 'approval' | 'notification';
    };
    status: string;
    reason?: string;
    decisionNote?: string;
    reviewedBy?: string;
    reviewedAt?: string;
    promotedVectorCount: number;
    createdAt: string;
    updatedAt: string;
};

const statusBadgeClass = (status: string) => {
    if (status === 'pending') return 'bg-yellow-950/40 border-yellow-800/50 text-yellow-400';
    if (status === 'approved') return 'bg-emerald-950/40 border-emerald-800/50 text-emerald-400';
    if (status === 'auto_shared' || status === 'shared_notified') return 'bg-blue-950/40 border-blue-800/50 text-blue-400';
    if (status === 'reverted') return 'bg-zinc-900 border-zinc-700 text-zinc-300';
    if (status === 'delivery_failed') return 'bg-orange-950/40 border-orange-800/50 text-orange-400';
    if (status === 'rejected') return 'bg-red-950/40 border-red-800/50 text-red-400';
    return 'bg-[#1a1a1a] text-zinc-500';
};

export const VectorShareRequestsPage = () => {
    const { token, session } = useAdminAuth();
    const [requests, setRequests] = useState<ShareRequest[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [companyId, setCompanyId] = useState('');
    const [actionLoading, setActionLoading] = useState<string | null>(null);

    const isSuperAdmin = session?.role === 'SUPER_ADMIN';
    const scopedCompanyId = useMemo(
        () => (isSuperAdmin ? companyId.trim() : undefined),
        [companyId, isSuperAdmin],
    );

    const buildQuery = () =>
        scopedCompanyId ? `?companyId=${encodeURIComponent(scopedCompanyId)}` : '';

    const load = async () => {
        if (!token) return;
        if (isSuperAdmin && !scopedCompanyId) { setRequests([]); return; }
        setLoading(true);
        setError(null);
        try {
            const data = await api.get<ShareRequest[]>(
                `/api/admin/company/vector-share-requests${buildQuery()}`,
                token,
            );
            setRequests(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load share requests.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { void load(); }, [token, scopedCompanyId]);

    const decide = async (requestId: string, decision: 'approve' | 'reject') => {
        if (!token) return;
        setActionLoading(requestId);
        setMessage(null);
        setError(null);
        try {
            const path = decision === 'approve'
                ? `/api/admin/company/vector-share-requests/${requestId}/approve`
                : `/api/admin/company/vector-share-requests/${requestId}/reject`;
            await api.post(path, scopedCompanyId ? { companyId: scopedCompanyId } : {}, token);
            setMessage(`Request ${decision === 'approve' ? 'approved' : 'rejected'} successfully.`);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : `Failed to ${decision} request.`);
        } finally {
            setActionLoading(null);
        }
    };

    const revert = async (requestId: string) => {
        if (!token) return;
        setActionLoading(requestId);
        setMessage(null);
        setError(null);
        try {
            await api.post(
                `/api/admin/company/vector-share-requests/${requestId}/revert`,
                scopedCompanyId ? { companyId: scopedCompanyId } : {},
                token,
            );
            setMessage('Request reverted successfully.');
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to revert request.');
        } finally {
            setActionLoading(null);
        }
    };

    return (
        <div className="flex flex-col gap-6 max-w-5xl">
            <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
                <CardHeader className="border-b border-[#1a1a1a] pb-4">
                    <CardTitle className="text-zinc-100">Knowledge Sharing</CardTitle>
                    <CardDescription className="text-zinc-500">
                        Review chat and file sharing, classifier outcomes, delivery health, and admin approvals.
                    </CardDescription>
                </CardHeader>
                <CardContent className="pt-6 space-y-6">
                    {isSuperAdmin && (
                        <div className="flex flex-col gap-2">
                            <span className="text-sm font-medium text-zinc-300">Workspace ID (required for super admin)</span>
                            <Input
                                value={companyId}
                                onChange={(e) => setCompanyId(e.target.value)}
                                placeholder="Paste workspace UUID"
                                className="bg-[#0a0a0a] border-[#222]"
                            />
                        </div>
                    )}

                    {error && (
                        <div className="bg-red-950/30 border border-red-900/50 text-red-400 p-3 rounded-md text-sm">{error}</div>
                    )}
                    {message && (
                        <div className="bg-emerald-950/30 border border-emerald-900/50 text-emerald-400 p-3 rounded-md text-sm">{message}</div>
                    )}

                    <div className="flex flex-col gap-3">
                        {loading ? (
                            <>
                                {[1, 2, 3].map((i) => (
                                    <div key={i} className="p-4 rounded-md bg-[#0a0a0a] border border-[#1a1a1a]">
                                        <Skeleton className="h-4 w-48 mb-2" />
                                        <Skeleton className="h-3 w-64 mb-3" />
                                        <Skeleton className="h-3 w-32" />
                                    </div>
                                ))}
                            </>
                        ) : requests.length === 0 ? (
                            <p className="text-sm text-zinc-500 italic p-3 rounded bg-[#0a0a0a] border border-dashed border-[#222]">
                                No share requests found.
                            </p>
                        ) : (
                            requests.map((req) => (
                                <div
                                    key={req.id}
                                    className="flex flex-col gap-3 p-4 rounded-md bg-[#0a0a0a] border border-[#1a1a1a]"
                                >
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="flex flex-col gap-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="text-sm font-medium text-zinc-200 truncate">
                                                    {req.requesterUserId}
                                                </span>
                                                {req.targetType && (
                                                    <Badge variant="outline" className="text-[10px] uppercase px-2 border border-zinc-700 text-zinc-300">
                                                        {req.targetType === 'file_asset' ? 'File' : 'Conversation'}
                                                    </Badge>
                                                )}
                                                {req.classification && (
                                                    <Badge variant="outline" className="text-[10px] uppercase px-2 border border-zinc-700 text-zinc-300">
                                                        {req.classification}
                                                    </Badge>
                                                )}
                                                <Badge
                                                    variant="outline"
                                                    className={`text-[10px] uppercase px-2 border ${statusBadgeClass(req.status)}`}
                                                >
                                                    {req.status}
                                                </Badge>
                                            </div>
                                            <span className="text-xs text-zinc-500 font-mono truncate">
                                                {req.fileName ?? req.conversationKey}
                                            </span>
                                            <div className="flex items-center gap-3 mt-1 text-xs text-zinc-600">
                                                <span>Requested {new Date(req.createdAt).toLocaleString()}</span>
                                                {req.promotedVectorCount > 0 && (
                                                    <span className="text-emerald-600">{req.promotedVectorCount} vectors promoted</span>
                                                )}
                                                {req.delivery && (
                                                    <span className="text-zinc-500">
                                                        delivery {req.delivery.successCount}/{req.delivery.recipientCount}
                                                    </span>
                                                )}
                                            </div>
                                            {typeof req.confidence === 'number' && (
                                                <p className="text-xs text-zinc-500 mt-1">
                                                    confidence {(req.confidence * 100).toFixed(0)}%
                                                </p>
                                            )}
                                            {req.reasons && req.reasons.length > 0 && (
                                                <p className="text-xs text-zinc-500 mt-1">
                                                    {req.reasons.join(' ')}
                                                </p>
                                            )}
                                            {req.summary && (
                                                <p className="text-sm text-zinc-300 mt-2 leading-6">
                                                    {req.summary}
                                                </p>
                                            )}
                                            {req.snapshotAt && (
                                                <p className="text-xs text-zinc-600 mt-1">
                                                    Shared snapshot through {new Date(req.snapshotAt).toLocaleString()}
                                                </p>
                                            )}
                                            {req.decisionNote && (
                                                <p className="text-xs text-zinc-500 mt-1 italic">Note: {req.decisionNote}</p>
                                            )}
                                        </div>

                                        {(req.status === 'pending' || req.status === 'delivery_failed') && (
                                            <div className="flex gap-2 shrink-0">
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    disabled={actionLoading === req.id}
                                                    onClick={() => void decide(req.id, 'approve')}
                                                    className="border-emerald-800/50 text-emerald-400 hover:bg-emerald-950/30 hover:border-emerald-700 transition-colors"
                                                >
                                                    {actionLoading === req.id ? '...' : 'Approve'}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    disabled={actionLoading === req.id}
                                                    onClick={() => void decide(req.id, 'reject')}
                                                    className="border-red-900/50 text-red-400 hover:bg-red-950/30 hover:border-red-800 transition-colors"
                                                >
                                                    {actionLoading === req.id ? '...' : 'Reject'}
                                                </Button>
                                            </div>
                                        )}

                                        {(req.status === 'approved' || req.status === 'auto_shared' || req.status === 'shared_notified') && (
                                            <div className="flex gap-2 shrink-0">
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    disabled={actionLoading === req.id}
                                                    onClick={() => void revert(req.id)}
                                                    className="border-zinc-700 text-zinc-200 hover:bg-zinc-900 hover:border-zinc-600 transition-colors"
                                                >
                                                    {actionLoading === req.id ? '...' : 'Revert'}
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};
