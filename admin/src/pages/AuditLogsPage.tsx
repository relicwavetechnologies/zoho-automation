import { FormEvent, useEffect, useState } from 'react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { api } from '../lib/api';

type AuditLog = {
  id: string;
  actor: string;
  companyId?: string | null;
  action: string;
  outcome: 'success' | 'failure';
  timestamp: string;
  metadata?: Record<string, unknown>;
};

export const AuditLogsPage = () => {
  const { token } = useAdminAuth();
  const [rows, setRows] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState<'success' | 'failure' | ''>('');
  const [selected, setSelected] = useState<AuditLog | null>(null);

  const load = async () => {
    if (!token) return;

    const params = new URLSearchParams();
    if (action) params.set('action', action);
    if (outcome) params.set('outcome', outcome);
    params.set('limit', '100');

    try {
      setLoading(true);
      const data = await api.get<AuditLog[]>(`/api/admin/audit/logs?${params.toString()}`, token);
      setRows(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token, action, outcome]); // Added action and outcome to dependencies to re-load on filter change

  const onFilter = async (event: FormEvent) => {
    event.preventDefault();
    await load();
  };

  return (
    <div className="flex flex-col gap-6 max-w-5xl relative">
      <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300 min-h-[600px]">
        <CardHeader className="border-b border-[#1a1a1a] pb-4">
          <CardTitle className="text-zinc-100">Audit Logs</CardTitle>
          <CardDescription className="text-zinc-500">Append-only stream for auth, RBAC, and control operations.</CardDescription>
        </CardHeader>
        <CardContent className="pt-6 space-y-6">
          <form onSubmit={onFilter} className="flex gap-3">
            <Input
              value={action}
              onChange={(event) => setAction(event.target.value)}
              placeholder="Filter action"
              className="bg-[#0a0a0a] border-[#222]"
            />
            <Select value={outcome || 'all'} onValueChange={(val) => setOutcome(val === 'all' ? '' : val as 'success' | 'failure')}>
              <SelectTrigger className="w-[180px] bg-[#0a0a0a] border-[#222]">
                <SelectValue placeholder="All outcomes" />
              </SelectTrigger>
              <SelectContent className="bg-[#111] border-[#222] text-zinc-300">
                <SelectItem value="all">All outcomes</SelectItem>
                <SelectItem value="success">Success</SelectItem>
                <SelectItem value="failure">Failure</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" variant="default" className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200">Apply Filters</Button>
          </form>

          <div className="flex flex-col gap-2">
            {loading ? (
              <>
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex items-center justify-between p-3 rounded-md bg-[#0a0a0a] border border-[#1a1a1a] h-[66px]">
                    <div className="flex flex-col gap-2 w-full">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-48" />
                    </div>
                    <Skeleton className="h-4 w-16 shrink-0" />
                  </div>
                ))}
              </>
            ) : (
              <>
                {rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className={`flex items-center justify-between p-3 rounded-md border text-left transition-colors ${selected?.id === row.id ? 'bg-[#1a1a1a] border-[#333]' : 'bg-[#0a0a0a] border-[#1a1a1a] hover:bg-[#111] hover:border-[#222]'} `}
                    onClick={() => setSelected(row)}
                  >
                    <div className="flex flex-col">
                      <strong className="text-zinc-200 text-sm font-medium">{row.action}</strong>
                      <span className="text-xs text-zinc-500 mt-1">
                        <span className={row.outcome === 'success' ? 'text-emerald-400' : 'text-red-400'}>{row.outcome.toUpperCase()}</span> &middot; {new Date(row.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <span className="text-xs text-zinc-400">{row.actor}</span>
                  </button>
                ))}
                {rows.length === 0 ? <p className="text-sm text-zinc-500 italic p-2 rounded bg-[#0a0a0a] border border-dashed border-[#222]">No logs match the criteria.</p> : null}
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {selected ? (
        <div className="absolute top-0 right-0 h-full w-full md:w-[400px] bg-[#0c0c0c] border-l border-[#1a1a1a] shadow-2xl z-10 p-6 flex flex-col gap-4 overflow-y-auto">
          <div className="flex items-center justify-between border-b border-[#1a1a1a] pb-4">
            <h2 className="text-zinc-100 font-medium text-lg">Audit Detail</h2>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)} className="text-zinc-400 hover:text-zinc-100 hover:bg-[#1a1a1a]">
              Close
            </Button>
          </div>
          <pre className="text-xs text-zinc-400 bg-[#0a0a0a] p-4 rounded-md border border-[#222] overflow-x-auto">
            {JSON.stringify(selected, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
};
