import { Shield, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ApprovalRequest } from '@/types/chat';

interface ApprovalCardProps {
  approval: ApprovalRequest;
}

export function ApprovalCard({ approval }: ApprovalCardProps) {
  const isPending = approval.status === 'pending';
  const isApproved = approval.status === 'approved';

  return (
    <div
      className="overflow-hidden rounded-md border"
      style={{
        borderColor: isPending ? 'hsl(38 70% 30%)' : isApproved ? 'hsl(142 50% 28%)' : 'hsl(0 50% 30%)',
        background:
          'linear-gradient(180deg, hsl(38 30% 8%), hsl(var(--surface-1)))',
      }}
    >
      <div
        className="flex items-center gap-2.5 border-b px-4 py-2.5"
        style={{
          background: 'hsl(38 35% 10%)',
          borderColor: 'hsl(38 60% 22%)',
        }}
      >
        <Shield className="h-3.5 w-3.5 text-warning" />
        <span className="text-[13px] font-medium text-foreground">
          {isPending
            ? 'Manager approval required'
            : isApproved
            ? 'Approved'
            : 'Rejected'}
        </span>
        {approval.approvers?.length ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10.5px] font-medium text-warning">
            {isPending ? `Awaiting ${approval.approvers[0]}` : approval.resolvedBy ?? 'Resolved'}
          </span>
        ) : null}
      </div>

      <div className="px-4 py-3.5 text-[12.5px] text-fg-muted">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-1.5">
          <dt className="text-fg-dim">Action</dt>
          <dd className="m-0 text-foreground">{approval.action}</dd>
          <dt className="text-fg-dim">Reason</dt>
          <dd className="m-0 text-foreground">{approval.reason}</dd>
          {Object.entries(approval.payload).slice(0, 6).map(([k, v]) => (
            <span key={k} className="contents">
              <dt className="text-fg-dim capitalize">{k.replace(/[_-]/g, ' ')}</dt>
              <dd className="m-0 truncate text-foreground">
                {typeof v === 'string' ? v : JSON.stringify(v)}
              </dd>
            </span>
          ))}
        </dl>
      </div>

      {isPending ? (
        <div className="flex gap-2 px-4 pb-3.5">
          <Button variant="secondary" size="sm">
            View full draft
          </Button>
          <div className="flex-1" />
          <Button variant="destructive" size="sm">
            <X className="h-3.5 w-3.5" />
            Reject
          </Button>
          <Button variant="default" size="sm">
            <Check className="h-3.5 w-3.5" />
            Approve & send
          </Button>
        </div>
      ) : null}
    </div>
  );
}
