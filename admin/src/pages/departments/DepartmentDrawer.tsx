import { useEffect, useRef, useState } from "react"
import { AlertTriangle, GripVertical, RefreshCw, Trash2, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { StatusBadge } from "@/components/admin/status-badge"
import { cn } from "@/lib/utils"
import type { DepartmentDetail, DepartmentDetailSection, DepartmentMembership, DepartmentSummary } from "@/lib/api"
import { ConfigTab } from "./tabs/ConfigTab"
import { MembersTab } from "./tabs/MembersTab"
import { OverviewTab } from "./tabs/OverviewTab"
import { PermissionsTab } from "./tabs/PermissionsTab"
import { RolesTab } from "./tabs/RolesTab"
import type { DepartmentToolCatalogEntry } from "./use-department-data"

type Props = {
  department: DepartmentSummary | null
  detail: DepartmentDetail | null
  detailLoading: boolean
  toolCatalogById: Record<string, DepartmentToolCatalogEntry>
  onClose: () => void
  onLoadSection: (
    id: string,
    sections: DepartmentDetailSection | DepartmentDetailSection[],
    force?: boolean,
  ) => Promise<DepartmentDetail | null>
  isSectionLoading: (id: string, section: DepartmentDetailSection) => boolean
  getSectionError: (id: string, section: DepartmentDetailSection) => string | null
  onUpdateDepartment: (id: string, data: { name?: string; description?: string | null; status?: "active" | "archived" }) => Promise<void>
  onArchiveDepartment: (id: string) => Promise<void>
  onCreateRole: (departmentId: string, data: { name: string; slug: string; zohoReadScope?: "personalized" | "show_all" }) => Promise<void>
  onUpdateRole: (departmentId: string, roleId: string, data: { name: string; isDefault?: boolean; zohoReadScope?: "personalized" | "show_all" }) => Promise<void>
  onDeleteRole: (departmentId: string, roleId: string) => Promise<void>
  onSearchCandidates: (departmentId: string, query: string) => Promise<Array<{
    channelIdentityId: string
    userId?: string
    name?: string
    email?: string
    workspaceRole?: string
    isWorkspaceMember: boolean
    isAlreadyAssigned: boolean
    larkDisplayName?: string
    larkUserId?: string
    larkOpenId?: string
    larkSourceRoles: string[]
  }>>
  onAddMember: (departmentId: string, data: { userId?: string; channelIdentityId?: string; roleId?: string }) => Promise<DepartmentMembership | null>
  onRemoveMember: (departmentId: string, userId: string) => Promise<void>
  onSetRolePermission: (departmentId: string, roleId: string, toolId: string, actionGroup: string, allowed: boolean) => Promise<void>
  onSetUserOverride: (departmentId: string, userId: string, toolId: string, actionGroup: string, allowed: boolean) => Promise<void>
  onUpdateConfig: (departmentId: string, data: {
    systemPrompt: string
    desktopPersonaPrompt: string
    skillsMarkdown: string
    zohoRateLimit?: unknown
    managerApproval?: unknown
    isActive?: boolean
  }) => Promise<void>
}

const MIN_W = 360
const MAX_W = 900
const DEFAULT_W = 520
const STORAGE_KEY = "divo_admin_department_drawer_width"
const TAB_ORDER: DepartmentDetailSection[] = ["overview", "roles", "members", "permissions", "config"]

function sectionIsLoaded(detail: DepartmentDetail | null, section: DepartmentDetailSection) {
  return Boolean(detail?.loadedSections.includes(section))
}

function roleDataAvailable(detail: DepartmentDetail | null) {
  return Boolean(detail && (detail.loadedSections.includes("roles") || detail.loadedSections.includes("members") || detail.loadedSections.includes("permissions")))
}

function memberDataAvailable(detail: DepartmentDetail | null) {
  return Boolean(detail && (detail.loadedSections.includes("members") || detail.loadedSections.includes("permissions")))
}

export function DepartmentDrawer({
  department,
  detail,
  detailLoading,
  toolCatalogById,
  onClose,
  onLoadSection,
  isSectionLoading,
  getSectionError,
  onUpdateDepartment,
  onArchiveDepartment,
  onCreateRole,
  onUpdateRole,
  onDeleteRole,
  onSearchCandidates,
  onAddMember,
  onRemoveMember,
  onSetRolePermission,
  onSetUserOverride,
  onUpdateConfig,
}: Props) {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_W
    const stored = Number(localStorage.getItem(STORAGE_KEY))
    return stored && stored >= MIN_W && stored <= MAX_W ? stored : DEFAULT_W
  })
  const [isResizing, setIsResizing] = useState(false)
  const [tab, setTab] = useState<DepartmentDetailSection>("overview")
  const widthRef = useRef(width)

  useEffect(() => {
    widthRef.current = width
  }, [width])

  useEffect(() => {
    setTab("overview")
  }, [department?.id])

  useEffect(() => {
    if (!isResizing) return
    const handleMove = (event: MouseEvent) => {
      const next = Math.max(MIN_W, Math.min(MAX_W, window.innerWidth - event.clientX))
      setWidth(next)
    }
    const handleUp = () => {
      setIsResizing(false)
      localStorage.setItem(STORAGE_KEY, String(widthRef.current))
    }
    document.body.style.cursor = "ew-resize"
    document.body.style.userSelect = "none"
    window.addEventListener("mousemove", handleMove)
    window.addEventListener("mouseup", handleUp)
    return () => {
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      window.removeEventListener("mousemove", handleMove)
      window.removeEventListener("mouseup", handleUp)
    }
  }, [isResizing])

  useEffect(() => {
    if (!department) return
    if (!sectionIsLoaded(detail, tab) && !isSectionLoading(department.id, tab)) {
      void onLoadSection(department.id, tab)
    }
  }, [department, detail, isSectionLoading, onLoadSection, tab])

  return (
    <Sheet open={!!department} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="overflow-hidden border-l border-border/40 bg-mat p-0 sm:!max-w-none"
        style={{ width }}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize drawer"
          onMouseDown={(event) => {
            event.preventDefault()
            setIsResizing(true)
          }}
          className={cn(
            "group absolute left-0 top-0 z-20 flex h-full w-1.5 cursor-ew-resize items-center justify-center transition-colors",
            isResizing ? "bg-accent/40" : "hover:bg-accent/30",
          )}
        >
          <div
            className={cn(
              "flex h-12 w-3 -translate-x-1 items-center justify-center rounded-r-full bg-border/60 opacity-0 transition-opacity group-hover:opacity-100",
              isResizing && "bg-accent opacity-100",
            )}
          >
            <GripVertical className="h-3 w-3 text-mat" />
          </div>
        </div>

        {department ? (
          <DepartmentDrawerContent
            department={department}
            detail={detail}
            detailLoading={detailLoading}
            toolCatalogById={toolCatalogById}
            tab={tab}
            onTabChange={setTab}
            onLoadSection={onLoadSection}
            isSectionLoading={isSectionLoading}
            getSectionError={getSectionError}
            onUpdateDepartment={onUpdateDepartment}
            onArchiveDepartment={onArchiveDepartment}
            onCreateRole={onCreateRole}
            onUpdateRole={onUpdateRole}
            onDeleteRole={onDeleteRole}
            onSearchCandidates={onSearchCandidates}
            onAddMember={onAddMember}
            onRemoveMember={onRemoveMember}
            onSetRolePermission={onSetRolePermission}
            onSetUserOverride={onSetUserOverride}
            onUpdateConfig={onUpdateConfig}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function DepartmentDrawerContent({
  department,
  detail,
  detailLoading,
  toolCatalogById,
  tab,
  onTabChange,
  onLoadSection,
  isSectionLoading,
  getSectionError,
  onUpdateDepartment,
  onArchiveDepartment,
  onCreateRole,
  onUpdateRole,
  onDeleteRole,
  onSearchCandidates,
  onAddMember,
  onRemoveMember,
  onSetRolePermission,
  onSetUserOverride,
  onUpdateConfig,
}: Omit<Props, "department" | "onClose"> & {
  department: DepartmentSummary
  tab: DepartmentDetailSection
  onTabChange: (value: DepartmentDetailSection) => void
}) {
  const [headerBusy, setHeaderBusy] = useState(false)
  const currentTabLoading = isSectionLoading(department.id, tab)
  const currentTabError = getSectionError(department.id, tab)
  const canShowRoles = roleDataAvailable(detail)
  const canShowMembers = memberDataAvailable(detail)

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        <SheetHeader className="space-y-3 border-b border-border/40 bg-card p-5 pl-6">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <Users className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-accent">Department workspace</p>
              <SheetTitle className="text-lg font-semibold leading-tight">{detail?.department.name ?? department.name}</SheetTitle>
              <SheetDescription className="font-mono text-[12px] text-muted-foreground">{detail?.department.slug ?? department.slug}</SheetDescription>
            </div>
            <StatusBadge value={detail?.department.status ?? department.status} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {canShowMembers ? detail?.memberships.length ?? department.memberCount : department.memberCount} members
            </span>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {canShowRoles ? detail?.roles.length ?? department.roleCount : department.roleCount} roles
            </span>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {sectionIsLoaded(detail, "config") ? detail?.departmentSkills.length ?? 0 : 0} skills
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-[12px]"
              disabled={headerBusy}
              onClick={async () => {
                setHeaderBusy(true)
                try {
                  await onLoadSection(department.id, tab, true)
                } finally {
                  setHeaderBusy(false)
                }
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reload tab
            </Button>
            {(detail?.department.status ?? department.status) !== "archived" ? (
              <Button
                type="button"
                size="sm"
                className="h-8 bg-emphasis text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90"
                disabled={headerBusy}
                onClick={async () => {
                  setHeaderBusy(true)
                  try {
                    await onArchiveDepartment(department.id)
                  } finally {
                    setHeaderBusy(false)
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Archive
              </Button>
            ) : null}
          </div>
        </SheetHeader>

        <div className="p-5 pl-6">
          {!detail && detailLoading ? <DrawerSkeleton kind="overview" /> : null}

          <Tabs value={tab} onValueChange={(value) => onTabChange(value as DepartmentDetailSection)} className="space-y-4">
            <TabsList className="h-auto flex-wrap justify-start gap-1 rounded-lg bg-secondary p-1">
              {TAB_ORDER.map((section) => (
                <TabsTrigger key={section} value={section} className="text-[12px] capitalize">
                  {section}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="overview" className="mt-0">
              {detail && sectionIsLoaded(detail, "overview") ? (
                <OverviewTab
                  detail={detail}
                  onSave={(data) => onUpdateDepartment(detail.department.id, data)}
                />
              ) : currentTabLoading || !currentTabError ? (
                <DrawerSkeleton kind="overview" />
              ) : (
                <TabErrorState
                  message={currentTabError}
                  onRetry={() => void onLoadSection(department.id, "overview", true)}
                />
              )}
            </TabsContent>

            <TabsContent value="roles" className="mt-0">
              {detail && sectionIsLoaded(detail, "roles") ? (
                <RolesTab
                  departmentId={detail.department.id}
                  roles={detail.roles}
                  onCreate={onCreateRole}
                  onUpdate={onUpdateRole}
                  onDelete={onDeleteRole}
                />
              ) : isSectionLoading(department.id, "roles") || !getSectionError(department.id, "roles") ? (
                <DrawerSkeleton kind="list" />
              ) : (
                <TabErrorState
                  message={getSectionError(department.id, "roles")}
                  onRetry={() => void onLoadSection(department.id, "roles", true)}
                />
              )}
            </TabsContent>

            <TabsContent value="members" className="mt-0">
              {detail && sectionIsLoaded(detail, "members") ? (
                <MembersTab
                  departmentId={detail.department.id}
                  memberships={detail.memberships}
                  roles={detail.roles}
                  onSearchCandidates={onSearchCandidates}
                  onAddMember={onAddMember}
                  onRemoveMember={onRemoveMember}
                />
              ) : isSectionLoading(department.id, "members") || !getSectionError(department.id, "members") ? (
                <DrawerSkeleton kind="list" />
              ) : (
                <TabErrorState
                  message={getSectionError(department.id, "members")}
                  onRetry={() => void onLoadSection(department.id, "members", true)}
                />
              )}
            </TabsContent>

            <TabsContent value="permissions" className="mt-0">
              {detail && sectionIsLoaded(detail, "permissions") ? (
                <PermissionsTab
                  departmentId={detail.department.id}
                  roles={detail.roles}
                  memberships={detail.memberships}
                  availableTools={detail.availableTools}
                  toolPermissions={detail.toolPermissions}
                  userOverrides={detail.userOverrides}
                  toolCatalogById={toolCatalogById}
                  onSetRolePermission={onSetRolePermission}
                  onSetUserOverride={onSetUserOverride}
                />
              ) : isSectionLoading(department.id, "permissions") || !getSectionError(department.id, "permissions") ? (
                <DrawerSkeleton kind="permissions" />
              ) : (
                <TabErrorState
                  message={getSectionError(department.id, "permissions")}
                  onRetry={() => void onLoadSection(department.id, "permissions", true)}
                />
              )}
            </TabsContent>

            <TabsContent value="config" className="mt-0">
              {detail && sectionIsLoaded(detail, "config") ? (
                <ConfigTab detail={detail} onSave={(data) => onUpdateConfig(detail.department.id, data)} />
              ) : isSectionLoading(department.id, "config") || !getSectionError(department.id, "config") ? (
                <DrawerSkeleton kind="config" />
              ) : (
                <TabErrorState
                  message={getSectionError(department.id, "config")}
                  onRetry={() => void onLoadSection(department.id, "config", true)}
                />
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}

function TabErrorState({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-destructive/20 bg-card p-4 shadow-soft">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
        <div className="space-y-2">
          <div>
            <p className="text-[13px] font-semibold">Section unavailable</p>
            <p className="text-[11px] text-muted-foreground">{message ?? "This tab has not loaded yet."}</p>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-8 bg-emphasis text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90"
            onClick={onRetry}
          >
            Retry
          </Button>
        </div>
      </div>
    </div>
  )
}

function DrawerSkeleton({ kind }: { kind: "overview" | "list" | "permissions" | "config" }) {
  if (kind === "overview") {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
        </div>
        <Skeleton className="h-36 rounded-lg" />
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
        </div>
      </div>
    )
  }

  if (kind === "permissions") {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-48 rounded-lg" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    )
  }

  if (kind === "config") {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 rounded-lg" />
        <div className="grid gap-4 xl:grid-cols-2">
          <Skeleton className="h-56 rounded-lg" />
          <Skeleton className="h-56 rounded-lg" />
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <Skeleton className="h-20 rounded-lg" />
      <Skeleton className="h-20 rounded-lg" />
      <Skeleton className="h-20 rounded-lg" />
    </div>
  )
}
