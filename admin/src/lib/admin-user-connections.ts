import type { LucideIcon } from "lucide-react"
import { CalendarDays, FileSpreadsheet, FileText, Mail } from "lucide-react"

export type AdminConnectionKind = "personal" | "company_shared"
export type AdminConnectionAccess = "read_only" | "read_write" | "admin"
export type AdminConnectionStatus = "connected" | "needs_attention" | "revoked"

export type AdminUserConnection = {
  id: string
  provider: "Google Workspace"
  label: string
  accountEmail: string
  kind: AdminConnectionKind
  access: AdminConnectionAccess
  status: AdminConnectionStatus
  ownerName: string
  ownerEmail: string
  adminName?: string
  adminEmail?: string
  sharedByName?: string
  sharedByEmail?: string
  sharedFrom?: string
  sharedTo: string[]
  piAlias: string
  policy: string
  scopes: string[]
  lastUsedAt: string
  services: Array<{
    name: string
    icon: LucideIcon
    access: AdminConnectionAccess
  }>
}

export type AdminUserProfile = {
  id: string
  name: string
  email: string
  role: "MEMBER" | "COMPANY_ADMIN" | "SUPER_ADMIN"
  status: "active" | "pending" | "disabled"
  managerName?: string
  managerEmail?: string
  departments: string[]
  canShareConnections: boolean
  administeredConnections: string[]
  connections: AdminUserConnection[]
}

const googleServices = {
  gmailRead: { name: "Gmail", icon: Mail, access: "read_only" as const },
  gmailWrite: { name: "Gmail", icon: Mail, access: "read_write" as const },
  driveRead: { name: "Drive", icon: FileText, access: "read_only" as const },
  calendarWrite: { name: "Calendar", icon: CalendarDays, access: "read_write" as const },
  sheetsRead: { name: "Sheets", icon: FileSpreadsheet, access: "read_only" as const },
}

export const adminUserProfiles: AdminUserProfile[] = [
  {
    id: "anugra-gupta",
    name: "Anugra Gupta",
    email: "anugra.gupta@emiactech.com",
    role: "COMPANY_ADMIN",
    status: "active",
    managerName: "Company Admin",
    managerEmail: "admin@emiactech.com",
    departments: ["Founders", "Outreach"],
    canShareConnections: true,
    administeredConnections: ["Outreach mailbox", "Sales workspace"],
    connections: [
      {
        id: "google-anugra-personal",
        provider: "Google Workspace",
        label: "Anugra personal workspace",
        accountEmail: "anugra.gupta@emiactech.com",
        kind: "personal",
        access: "read_write",
        status: "connected",
        ownerName: "Anugra Gupta",
        ownerEmail: "anugra.gupta@emiactech.com",
        adminName: "Anugra Gupta",
        adminEmail: "anugra.gupta@emiactech.com",
        sharedTo: ["Only Anugra"],
        piAlias: "Anugra Personal Google",
        policy: "Personal account. Pi can read and write only when Anugra selects this connection.",
        scopes: ["Gmail read/write", "Drive read", "Calendar read/write"],
        lastUsedAt: "Today",
        services: [googleServices.gmailWrite, googleServices.driveRead, googleServices.calendarWrite],
      },
      {
        id: "google-outreach-readonly",
        provider: "Google Workspace",
        label: "Outreach mailbox",
        accountEmail: "outreach@emiactech.com",
        kind: "company_shared",
        access: "read_only",
        status: "connected",
        ownerName: "Growth Ops",
        ownerEmail: "outreach@emiactech.com",
        adminName: "Anugra Gupta",
        adminEmail: "anugra.gupta@emiactech.com",
        sharedByName: "Anugra Gupta",
        sharedByEmail: "anugra.gupta@emiactech.com",
        sharedFrom: "Outreach department",
        sharedTo: ["Outreach", "Founders"],
        piAlias: "Outreach Mail Read-only",
        policy: "Read-only grant. Pi can inspect threads and context but cannot draft, send, archive, or mutate labels.",
        scopes: ["Gmail read", "Drive read"],
        lastUsedAt: "1h ago",
        services: [googleServices.gmailRead, googleServices.driveRead],
      },
      {
        id: "google-sales-shared",
        provider: "Google Workspace",
        label: "Sales workspace",
        accountEmail: "sales@emiactech.com",
        kind: "company_shared",
        access: "read_write",
        status: "connected",
        ownerName: "Revenue",
        ownerEmail: "sales@emiactech.com",
        adminName: "Anugra Gupta",
        adminEmail: "anugra.gupta@emiactech.com",
        sharedByName: "Anugra Gupta",
        sharedByEmail: "anugra.gupta@emiactech.com",
        sharedFrom: "Sales department",
        sharedTo: ["Sales", "Founders"],
        piAlias: "Sales Google",
        policy: "Shared write grant. Sending and document updates still require approval when policy marks the tool as sensitive.",
        scopes: ["Gmail read/write", "Drive read", "Calendar read/write"],
        lastUsedAt: "Yesterday",
        services: [googleServices.gmailWrite, googleServices.driveRead, googleServices.calendarWrite],
      },
    ],
  },
  {
    id: "omesh-parwani",
    name: "Omesh Parwani",
    email: "omesh.parwani@macobstech.com",
    role: "MEMBER",
    status: "active",
    managerName: "Anugra Gupta",
    managerEmail: "anugra.gupta@emiactech.com",
    departments: ["Outreach"],
    canShareConnections: false,
    administeredConnections: [],
    connections: [
      {
        id: "google-omesh-personal",
        provider: "Google Workspace",
        label: "Omesh personal workspace",
        accountEmail: "omesh.parwani@macobstech.com",
        kind: "personal",
        access: "read_write",
        status: "connected",
        ownerName: "Omesh Parwani",
        ownerEmail: "omesh.parwani@macobstech.com",
        adminName: "Omesh Parwani",
        adminEmail: "omesh.parwani@macobstech.com",
        sharedTo: ["Only Omesh"],
        piAlias: "Omesh Personal Google",
        policy: "Personal account. Not visible to other users unless explicitly shared later.",
        scopes: ["Gmail read/write", "Drive read", "Calendar read/write"],
        lastUsedAt: "Today",
        services: [googleServices.gmailWrite, googleServices.driveRead, googleServices.calendarWrite],
      },
      {
        id: "google-omesh-outreach",
        provider: "Google Workspace",
        label: "Outreach mailbox",
        accountEmail: "outreach@emiactech.com",
        kind: "company_shared",
        access: "read_only",
        status: "connected",
        ownerName: "Growth Ops",
        ownerEmail: "outreach@emiactech.com",
        adminName: "Anugra Gupta",
        adminEmail: "anugra.gupta@emiactech.com",
        sharedByName: "Anugra Gupta",
        sharedByEmail: "anugra.gupta@emiactech.com",
        sharedFrom: "Outreach department",
        sharedTo: ["Outreach"],
        piAlias: "Outreach Mail Read-only",
        policy: "Read-only outreach grant inherited from department membership.",
        scopes: ["Gmail read", "Drive read"],
        lastUsedAt: "2h ago",
        services: [googleServices.gmailRead, googleServices.driveRead],
      },
      {
        id: "google-omesh-finance",
        provider: "Google Workspace",
        label: "Finance docs",
        accountEmail: "finance@emiactech.com",
        kind: "company_shared",
        access: "read_only",
        status: "connected",
        ownerName: "Finance",
        ownerEmail: "finance@emiactech.com",
        adminName: "Karan Mehta",
        adminEmail: "karan@emiactech.com",
        sharedByName: "Karan Mehta",
        sharedByEmail: "karan@emiactech.com",
        sharedFrom: "Founders role override",
        sharedTo: ["Omesh Parwani"],
        piAlias: "Finance Drive Read-only",
        policy: "Direct user grant for reading finance sheets. No email access.",
        scopes: ["Drive read", "Sheets read"],
        lastUsedAt: "3d ago",
        services: [googleServices.driveRead, googleServices.sheetsRead],
      },
    ],
  },
  {
    id: "ankit-nagar",
    name: "Ankit Nagar",
    email: "ankit.nagar@emiactech.com",
    role: "MEMBER",
    status: "active",
    managerName: "Anugra Gupta",
    managerEmail: "anugra.gupta@emiactech.com",
    departments: ["Sales"],
    canShareConnections: false,
    administeredConnections: [],
    connections: [
      {
        id: "google-ankit-sales",
        provider: "Google Workspace",
        label: "Sales workspace",
        accountEmail: "sales@emiactech.com",
        kind: "company_shared",
        access: "read_write",
        status: "connected",
        ownerName: "Revenue",
        ownerEmail: "sales@emiactech.com",
        adminName: "Anugra Gupta",
        adminEmail: "anugra.gupta@emiactech.com",
        sharedByName: "Anugra Gupta",
        sharedByEmail: "anugra.gupta@emiactech.com",
        sharedFrom: "Sales department",
        sharedTo: ["Sales"],
        piAlias: "Sales Google",
        policy: "Department shared grant for customer follow-up work.",
        scopes: ["Gmail read/write", "Drive read", "Calendar read/write"],
        lastUsedAt: "Yesterday",
        services: [googleServices.gmailWrite, googleServices.driveRead, googleServices.calendarWrite],
      },
    ],
  },
]

export function getAdminProfileByUserId(userId: string | undefined) {
  if (!userId) return undefined
  const normalized = decodeURIComponent(userId).toLowerCase()
  return adminUserProfiles.find((profile) => profile.id === normalized || profile.email.toLowerCase() === normalized)
}

export function getAdminProfilePreviewByUserId(userId: string | undefined) {
  const profile = getAdminProfileByUserId(userId)
  if (profile) return profile
  return createPreviewProfile(userId)
}

export function getAdminProfileByEmail(email: string | undefined) {
  if (!email) return undefined
  const normalized = email.toLowerCase()
  return adminUserProfiles.find((profile) => profile.email.toLowerCase() === normalized)
}

export function connectionSummaryForEmail(email: string | undefined) {
  const profile = getAdminProfileByEmail(email) ?? createPreviewProfile(email)
  if (!profile) return { total: 0, personal: 0, shared: 0 }
  const personal = profile.connections.filter((connection) => connection.kind === "personal").length
  const shared = profile.connections.length - personal
  return { total: profile.connections.length, personal, shared }
}

function createPreviewProfile(userId: string | undefined): AdminUserProfile | undefined {
  if (!userId) return undefined
  const decoded = decodeURIComponent(userId)
  const looksLikeEmail = decoded.includes("@")
  const email = looksLikeEmail ? decoded.toLowerCase() : "selected.member@company.local"
  const localName = email.split("@")[0] ?? "selected.member"
  const name = localName
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Selected Member"

  return {
    id: decoded.toLowerCase(),
    name,
    email,
    role: "MEMBER",
    status: "active",
    managerName: "Company Admin",
    managerEmail: "admin@company.local",
    departments: ["Preview department"],
    canShareConnections: false,
    administeredConnections: [],
    connections: [
      {
        id: "preview-personal-google",
        provider: "Google Workspace",
        label: `${name} personal workspace`,
        accountEmail: email,
        kind: "personal",
        access: "read_write",
        status: "needs_attention",
        ownerName: name,
        ownerEmail: email,
        adminName: name,
        adminEmail: email,
        sharedTo: [`Only ${name}`],
        piAlias: `${name} Personal Google`,
        policy: "UI preview placeholder. Backend connection registry will replace this with the user's real OAuth connection and policy.",
        scopes: ["Gmail read/write", "Drive read", "Calendar read/write"],
        lastUsedAt: "Not connected",
        services: [googleServices.gmailWrite, googleServices.driveRead, googleServices.calendarWrite],
      },
      {
        id: "preview-shared-google",
        provider: "Google Workspace",
        label: "Shared team workspace",
        accountEmail: "shared@company.local",
        kind: "company_shared",
        access: "read_only",
        status: "needs_attention",
        ownerName: "Company Workspace",
        ownerEmail: "shared@company.local",
        adminName: "Company Admin",
        adminEmail: "admin@company.local",
        sharedByName: "Company Admin",
        sharedByEmail: "admin@company.local",
        sharedFrom: "Department grant preview",
        sharedTo: [name],
        piAlias: "Team Google Read-only",
        policy: "UI preview placeholder for an admin-shared account. Live data should come from backend RBAC and connection grants.",
        scopes: ["Gmail read", "Drive read"],
        lastUsedAt: "Not connected",
        services: [googleServices.gmailRead, googleServices.driveRead],
      },
    ],
  }
}
