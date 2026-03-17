import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Badge } from '../components/ui/badge';
import { api } from '../lib/api';
import { useAdminAuth } from '../auth/AdminAuthProvider';

type MemberUsageRow = {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  totalTokens: number;
  monthlyLimit: number;
  percentUsed: number;
  lastModelId: string | null;
  compactionEvents: number;
};

type UsageBreakdown = {
  totalTokens: number;
  byModel: Record<string, { tokens: number; requests: number }>;
  byMode: { fast: number; high: number };
  compactionRate: number;
  members: MemberUsageRow[];
};

export default function TokenUsagePage() {
  const { session, token } = useAdminAuth();
  const [data, setData] = useState<UsageBreakdown | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session || !token) return;
    if (!session.companyId) {
      setLoading(false);
      return;
    }

    api
      .get<UsageBreakdown>(`/api/admin/company/${session.companyId}/token-usage`, token)
      .then((res) => {
        setData(res);
      })
      .catch((err) => {
        console.error('Failed to load token usage:', err);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [session, token]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full bg-zinc-900" />
        <Skeleton className="h-40 w-full bg-zinc-900" />
        <Skeleton className="h-40 w-full bg-zinc-900" />
      </div>
    );
  }

  if (!data) {
    return (
      <Card className="border-zinc-800 bg-[#111315] text-zinc-100">
        <CardHeader>
          <CardTitle>Token Usage</CardTitle>
          <CardDescription className="text-zinc-400">
            {session?.companyId
              ? 'Failed to load payload.'
              : 'Token usage is company-scoped. Open this view from a company-admin session.'}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="border-zinc-800 bg-[#111315] text-zinc-100">
        <CardHeader>
          <CardTitle>AI Token Usage Analytics</CardTitle>
          <CardDescription className="text-zinc-400">
            Company-wide breakdown of AI token consumption, model utilization, and context efficiency.
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <Card className="border-zinc-800 bg-zinc-950/70 text-zinc-100">
          <CardHeader className="pb-2">
            <CardDescription className="text-zinc-400">Total Tokens Generated</CardDescription>
            <CardTitle className="text-3xl font-light">
              {data.totalTokens >= 1_000_000 ? `${(data.totalTokens / 1_000_000).toFixed(2)}M` : data.totalTokens.toLocaleString()}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/70 text-zinc-100">
          <CardHeader className="pb-2">
            <CardDescription className="text-zinc-400">Fast Mode Volume</CardDescription>
            <CardTitle className="text-3xl font-light text-blue-400">
              {data.totalTokens > 0 ? Math.round((data.byMode.fast / data.totalTokens) * 100) : 0}%
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-zinc-500 pb-4">
            of total tokens used
          </CardContent>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/70 text-zinc-100">
          <CardHeader className="pb-2">
            <CardDescription className="text-zinc-400">High Mode Volume</CardDescription>
            <CardTitle className="text-3xl font-light text-amber-500">
              {data.totalTokens > 0 ? Math.round((data.byMode.high / data.totalTokens) * 100) : 0}%
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-zinc-500 pb-4">
            of total tokens used
          </CardContent>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/70 text-zinc-100">
          <CardHeader className="pb-2">
            <CardDescription className="text-zinc-400">Context Compaction Rate</CardDescription>
            <CardTitle className="text-3xl font-light text-green-400">
              {data.compactionRate}%
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-zinc-500 pb-4">
            requests effectively compressed
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* Model Distribution breakdown */}
        <Card className="col-span-1 border-zinc-800 bg-[#111315] text-zinc-100 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
          <CardHeader>
            <CardTitle className="text-base font-medium">Model Usage Heatmap</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {Object.entries(data.byModel)
                .sort(([, a], [, b]) => b.tokens - a.tokens)
                .map(([modelId, stats]) => (
                  <div key={modelId} className="flex flex-col gap-1">
                    <div className="flex justify-between items-center text-sm">
                      <span className="font-medium text-zinc-300">{modelId}</span>
                      <span className="text-zinc-500">
                        {((stats.tokens / Math.max(data.totalTokens, 1)) * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-zinc-900 overflow-hidden">
                      <div 
                        className="h-full bg-zinc-400 transition-all rounded-full" 
                        style={{ width: `${(stats.tokens / Math.max(data.totalTokens, 1)) * 100}%` }}
                      />
                    </div>
                    <div className="text-xs text-zinc-600 font-mono">
                      {(stats.tokens / 1000).toFixed(1)}k tokens · {stats.requests} reqs
                    </div>
                  </div>
              ))}
              {Object.keys(data.byModel).length === 0 && (
                <div className="text-sm text-zinc-600 italic">No model data recorded this month.</div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="col-span-2 border-zinc-800 bg-[#111315] text-zinc-100 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
          <CardHeader>
            <CardTitle className="text-base font-medium">Member Policy Enforcement</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader className="border-zinc-800">
                <TableRow className="border-zinc-800 hover:bg-zinc-900/50">
                  <TableHead className="text-zinc-400 font-medium">User</TableHead>
                  <TableHead className="text-zinc-400 font-medium text-right">Tokens Used</TableHead>
                  <TableHead className="text-zinc-400 font-medium text-right">Monthly Quota</TableHead>
                  <TableHead className="text-zinc-400 font-medium text-right">Usage</TableHead>
                  <TableHead className="text-zinc-400 font-medium text-right">Compaction</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.members.map((member) => (
                  <TableRow key={member.userId} className="border-zinc-800 hover:bg-zinc-900/50">
                    <TableCell className="font-medium text-zinc-300">
                      <div className="flex flex-col">
                        <span>{member.userName || member.userEmail || member.userId}</span>
                        {member.userName && member.userEmail && (
                          <span className="text-[10px] text-zinc-500 font-normal">{member.userEmail}</span>
                        )}
                        <span className="text-xs text-zinc-500 font-normal">{member.lastModelId}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-zinc-400 font-mono">
                      {member.totalTokens.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right text-zinc-500 font-mono text-xs">
                      {member.monthlyLimit.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge 
                        variant="outline" 
                        className={`font-mono ${member.percentUsed > 90 ? 'border-red-900 text-red-500' : member.percentUsed > 75 ? 'border-amber-900 text-amber-500' : 'border-zinc-700 text-zinc-400'}`}
                      >
                        {member.percentUsed > 0 && member.percentUsed < 0.01 ? '<0.01' : member.percentUsed}%
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-zinc-500 text-xs">
                      {member.compactionEvents} calls
                    </TableCell>
                  </TableRow>
                ))}
                
                {data.members.length === 0 && (
                  <TableRow className="border-zinc-800 hover:bg-transparent">
                    <TableCell colSpan={5} className="text-center text-zinc-600 py-6 italic">
                      No usage records found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
