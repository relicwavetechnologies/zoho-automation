import { invoke } from '@tauri-apps/api/core'
import {
  ArrowRight,
  Building2,
  CalendarRange,
  Check,
  ChevronDown,
  FileSearch,
  Landmark,
  LockKeyhole,
  ReceiptText,
  Search,
  ShieldCheck,
  WalletCards,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { ZohoIcon } from '@/components/brand-icons'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import {
  compileFinanceQuickStart,
  FINANCE_QUICK_STARTS,
  type DivoQuickStartPlan,
  type FinanceQuickStartDefinition,
} from '@/lib/divo-finance-quick-start'
import { cn } from '@/lib/utils'
import { FinanceDatePicker } from './FinanceDatePicker'

type RuntimeContext = {
  capabilityBootstrap?: {
    departmentFunction: string
    preferredSkills: Array<{ id: string; slug: string }>
    preferredTools: Array<{ toolId: string; actions: string[] }>
  }
}

type ZohoConnection = {
  connectionId: string
  label: string
  accountEmail: string | null
  accountName: string | null
  access: 'read_only' | 'read_write' | 'admin'
}

type ZohoStatus = {
  success: boolean
  data?: { connected: boolean; connections: ZohoConnection[] }
}

export type FinanceQuickStartRequest = {
  id: string
  prompt: string
  plan: DivoQuickStartPlan
}

type Props = {
  onSubmit: (request: FinanceQuickStartRequest) => void
  variant?: 'home' | 'launcher'
}

const GROUP_ICONS: Record<string, typeof ReceiptText> = {
  Receivables: WalletCards,
  'Invoice desk': ReceiptText,
  Payments: Landmark,
  'Bills & AP': FileSearch,
  Expenses: ReceiptText,
  'Cash & bank': Landmark,
  'Tax & accounts': ShieldCheck,
  'Finance analysis': Search,
}

const displayConnection = (connection: ZohoConnection) =>
  connection.label || connection.accountName || connection.accountEmail || 'Zoho Books'

export function FinanceQuickStarts({ onSubmit, variant = 'home' }: Props) {
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(false)
  const [allowedActions, setAllowedActions] = useState<string[]>([])
  const [preferredSkills, setPreferredSkills] = useState<
    Array<{ id: string; slug: string }>
  >([])
  const [connections, setConnections] = useState<ZohoConnection[]>([])
  const [selectedConnectionId, setSelectedConnectionId] = useState('')
  const [selected, setSelected] = useState<FinanceQuickStartDefinition | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [launcherOpen, setLauncherOpen] = useState(false)
  // The home grid is opt-in: it sits behind a toggle at the bottom of the page
  // so an empty chat opens clean.
  const [homeOpen, setHomeOpen] = useState(false)

  useEffect(() => {
    let active = true
    void Promise.all([
      invoke<RuntimeContext | null>('divo_get_runtime_context'),
      invoke<ZohoStatus>('divo_zoho_status'),
    ])
      .then(([context, status]) => {
        if (!active) return
        const bootstrap = context?.capabilityBootstrap
        const hasBooks = bootstrap?.preferredTools.some(
          (tool) => tool.toolId === 'zohoBooks'
        )
        const booksActions =
          bootstrap?.preferredTools.find((tool) => tool.toolId === 'zohoBooks')
            ?.actions ?? []
        const nextConnections = status.data?.connections ?? []
        setEnabled(bootstrap?.departmentFunction === 'finance' && Boolean(hasBooks))
        setAllowedActions(booksActions)
        setPreferredSkills(bootstrap?.preferredSkills ?? [])
        setConnections(nextConnections)
        setSelectedConnectionId(nextConnections[0]?.connectionId ?? '')
      })
      .catch(() => {
        if (active) setEnabled(false)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const groups = useMemo(() => {
    const byGroup = new Map<string, FinanceQuickStartDefinition[]>()
    for (const item of FINANCE_QUICK_STARTS.filter((definition) =>
      allowedActions.includes(definition.access === 'read' ? 'read' : 'create') &&
      (!definition.skillSlug ||
        preferredSkills.some((skill) => skill.slug === definition.skillSlug))
    )) {
      byGroup.set(item.group, [...(byGroup.get(item.group) ?? []), item])
    }
    return [...byGroup.entries()]
  }, [allowedActions, preferredSkills])

  const connection = connections.find(
    (item) => item.connectionId === selectedConnectionId
  )
  const canWrite = connection?.access !== 'read_only'
  const missingRequired = selected?.fields.some(
    (field) => field.required && !values[field.id]?.trim()
  )

  const open = (definition: FinanceQuickStartDefinition) => {
    setLauncherOpen(false)
    setSelected(definition)
    setValues(
      Object.fromEntries(
        definition.fields
          .filter((field) => field.type === 'select' && field.options?.[0])
          .map((field) => [field.id, field.options![0].value])
      )
    )
  }

  const submit = () => {
    if (!selected || !connection || missingRequired) return
    const compiled = compileFinanceQuickStart(
      selected,
      values,
      {
        connectionId: connection.connectionId,
        label: displayConnection(connection),
      },
      preferredSkills.find((skill) => skill.slug === selected.skillSlug)?.id
    )
    onSubmit({
      id: `${selected.id}:${Date.now()}`,
      ...compiled,
    })
    setSelected(null)
  }

  if (loading || !enabled) return null

  return (
    <section
      className={cn(variant === 'home' ? 'mt-6' : 'inline-flex')}
      data-testid="finance-quick-starts"
      data-variant={variant}
    >
      {variant === 'launcher' ? (
        <Popover open={launcherOpen} onOpenChange={setLauncherOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Open Finance quick starts"
              // Matches DivoModelToggle — every labelled control in the
              // composer bar reads at the same quiet weight.
              className="h-7 gap-1.5 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
            >
              <ZohoIcon className="size-3.5" />
              Quick starts
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[30rem] p-3">
            <div className="flex items-start justify-between gap-3 px-1 pb-3">
              <div className="flex items-start gap-2.5">
                <span className="flex size-9 items-center justify-center rounded-xl border bg-background">
                  <ZohoIcon className="size-5" />
                </span>
                <div>
                  <p className="text-sm font-medium">Finance quick starts</p>
                  <p className="text-xs text-muted-foreground">
                    Add a precise Zoho request to this chat
                  </p>
                </div>
              </div>
              {connection && connections.length > 1 ? (
                <AccountMenu
                  connections={connections}
                  selected={connection}
                  onSelect={setSelectedConnectionId}
                />
              ) : null}
            </div>
            <Separator className="mb-3" />
            {connections.length === 0 ? (
              <p className="px-1 py-3 text-sm text-muted-foreground">
                Connect Zoho Books to use Finance quick starts.
              </p>
            ) : (
              <QuickStartGrid groups={groups} onOpen={open} compact />
            )}
          </PopoverContent>
        </Popover>
      ) : (
        <>
          <div className="flex justify-center">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={homeOpen}
              aria-controls="finance-quick-starts-panel"
              className="text-muted-foreground"
              onClick={() => setHomeOpen((current) => !current)}
            >
              <ZohoIcon data-icon="inline-start" />
              Finance quick starts
              <ChevronDown
                data-icon="inline-end"
                className={cn('transition-transform', homeOpen && 'rotate-180')}
              />
            </Button>
          </div>

          {homeOpen ? (
            <div id="finance-quick-starts-panel" className="mt-4">
              <div className="mb-3 flex items-center justify-between gap-3 px-1">
                <div className="min-w-0">
                  <p className="truncate text-xs text-muted-foreground">
                    Exact Zoho Books routes, ready for your details
                  </p>
                </div>
                {connections.length > 1 && connection ? (
                  <AccountMenu
                    connections={connections}
                    selected={connection}
                    onSelect={setSelectedConnectionId}
                  />
                ) : connection ? (
                  <span className="inline-flex max-w-52 shrink-0 items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs text-muted-foreground">
                    <Building2 className="size-3 shrink-0" />
                    <span className="truncate">{displayConnection(connection)}</span>
                  </span>
                ) : null}
              </div>

              {connections.length === 0 ? (
                <Card className="rounded-2xl border-dashed bg-card/60">
                  <CardContent className="flex items-center gap-3 p-4">
                    <span className="flex size-9 items-center justify-center rounded-xl border bg-background">
                      <ZohoIcon className="size-5" />
                    </span>
                    <div>
                      <p className="text-sm font-medium">Connect Zoho Books to use quick starts</p>
                      <p className="text-xs text-muted-foreground">Your department permissions still control every action.</p>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <QuickStartGrid groups={groups} onOpen={open} />
              )}
            </div>
          ) : null}
        </>
      )}

      <Dialog open={Boolean(selected)} onOpenChange={(openState) => !openState && setSelected(null)}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
          {selected && (
            <>
              <DialogHeader className="border-b bg-card px-6 py-5 pr-12">
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-background shadow-xs">
                    <ZohoIcon className="size-6" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>Zoho Books</span><span>·</span><span>Finance quick start</span>
                    </div>
                    <DialogTitle>{selected.title}</DialogTitle>
                    <DialogDescription className="mt-1">{selected.description}</DialogDescription>
                  </div>
                </div>
              </DialogHeader>

              <div className="space-y-5 px-6 py-5">
                <div className="grid gap-3 rounded-xl border bg-background p-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Workflow</Label>
                    <WorkflowMenu
                      value={selected}
                      options={FINANCE_QUICK_STARTS.filter(
                        (item) =>
                          item.group === selected.group &&
                          allowedActions.includes(
                            item.access === 'read' ? 'read' : 'create'
                          ) &&
                          (!item.skillSlug ||
                            preferredSkills.some(
                              (skill) => skill.slug === item.skillSlug
                            ))
                      )}
                      onSelect={open}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Zoho account</Label>
                    {connection && (
                      <AccountMenu
                        className="h-9 w-full justify-between rounded-md"
                        connections={connections}
                        selected={connection}
                        onSelect={setSelectedConnectionId}
                      />
                    )}
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  {selected.fields.map((field) => (
                    <div key={field.id} className={cn('space-y-1.5', field.type === 'text' && 'sm:col-span-2')}>
                      <Label htmlFor={`quick-${field.id}`}>
                        {field.label}{field.required ? <span className="text-destructive"> *</span> : null}
                      </Label>
                      {field.type === 'date' ? (
                        <FinanceDatePicker
                          id={`quick-${field.id}`}
                          value={values[field.id]}
                          placeholder={`Select ${field.label.toLowerCase()}`}
                          required={field.required}
                          onChange={(value) =>
                            setValues((current) => ({
                              ...current,
                              [field.id]: value,
                            }))
                          }
                        />
                      ) : field.type === 'select' ? (
                        <OptionMenu
                          label={field.options?.find((option) => option.value === values[field.id])?.label ?? field.label}
                          options={field.options ?? []}
                          onSelect={(value) => setValues((current) => ({ ...current, [field.id]: value }))}
                        />
                      ) : (
                        <Input
                          id={`quick-${field.id}`}
                          type={field.type}
                          value={values[field.id] ?? ''}
                          placeholder={field.placeholder}
                          onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                        />
                      )}
                    </div>
                  ))}
                </div>

                <div className="rounded-xl border bg-muted/30 p-4">
                  <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <CalendarRange className="size-3.5" /> Request preview
                  </div>
                  <p className="text-sm leading-6">
                    {missingRequired
                      ? 'Complete the required fields to preview the exact request.'
                      : connection
                      ? selected.buildPrompt(values, displayConnection(connection))
                      : 'Select a Zoho account to preview this request.'}
                  </p>
                </div>
              </div>

              <Separator />
              <DialogFooter className="items-center justify-between px-6 py-4 sm:flex-row">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {selected.access === 'write' ? <LockKeyhole className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
                  {selected.access === 'write' && !canWrite
                    ? 'Selected account is read-only'
                    : selected.access === 'write'
                      ? 'Changes still require approval'
                      : 'Read-only request'}
                </div>
                <Button
                  disabled={!connection || Boolean(missingRequired) || (selected.access === 'write' && !canWrite)}
                  onClick={submit}
                >
                  Run in Divo <ArrowRight data-icon="inline-end" />
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}

function QuickStartGrid({ groups, onOpen, compact = false }: {
  groups: Array<[string, FinanceQuickStartDefinition[]]>
  onOpen: (definition: FinanceQuickStartDefinition) => void
  compact?: boolean
}) {
  return (
    <div className={cn('grid grid-cols-2 gap-3', !compact && 'lg:grid-cols-4')}>
      {groups.map(([group, items]) => {
        const Icon = GROUP_ICONS[group] ?? ReceiptText
        return (
          <button
            key={group}
            type="button"
            className={cn(
              'group flex flex-col rounded-xl border border-border/60 bg-card/60 p-4 text-left transition-colors hover:border-border hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              compact ? 'min-h-20' : 'min-h-[112px]'
            )}
            onClick={() => onOpen(items[0])}
          >
            <span className={cn('flex items-start justify-between', compact ? 'mb-2' : 'mb-3')}>
              <span className="flex size-9 items-center justify-center rounded-lg border bg-background">
                <Icon className="size-4 text-muted-foreground" />
              </span>
              <ArrowRight className="size-4 -translate-x-1 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
            </span>
            <span className="block text-sm font-medium">{group}</span>
            <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-muted-foreground">
              {items.map((item) => item.title).join(' · ')}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function AccountMenu({ connections, selected, onSelect, className }: {
  connections: ZohoConnection[]
  selected: ZohoConnection
  onSelect: (id: string) => void
  className?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={cn('max-w-56', className)}>
          <Building2 data-icon="inline-start" />
          <span className="truncate">{displayConnection(selected)}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Use Zoho Books account</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {connections.map((connection) => (
          <DropdownMenuItem key={connection.connectionId} onSelect={() => onSelect(connection.connectionId)}>
            <div className="min-w-0 flex-1">
              <p className="truncate">{displayConnection(connection)}</p>
              <p className="truncate text-xs text-muted-foreground">{connection.accountEmail ?? connection.access.replace('_', ' ')}</p>
            </div>
            {connection.connectionId === selected.connectionId && <Check />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function WorkflowMenu({ value, options, onSelect }: {
  value: FinanceQuickStartDefinition
  options: FinanceQuickStartDefinition[]
  onSelect: (definition: FinanceQuickStartDefinition) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="w-full justify-between font-normal">
          <span className="truncate">{value.title}</span><ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80">
        {options.map((option) => (
          <DropdownMenuItem key={option.id} onSelect={() => onSelect(option)}>
            <div><p>{option.title}</p><p className="text-xs text-muted-foreground">{option.description}</p></div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function OptionMenu({ label, options, onSelect }: {
  label: string
  options: Array<{ label: string; value: string }>
  onSelect: (value: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="w-full justify-between font-normal">
          {label}<ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)]">
        {options.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => onSelect(option.value)}>{option.label}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
