import {
  CalendarDays,
  Chrome,
  FileSpreadsheet,
  FileText,
  Github,
  HardDrive,
  Mail,
  Megaphone,
  MessageSquare,
  Puzzle,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react'
import type { ComponentType } from 'react'

export type DivoPluginCategory = 'connector' | 'skill' | 'data_source'

export type DivoConnectionKind = 'personal' | 'company_shared'

export type DivoConnectionStatus = 'connected' | 'needs_attention' | 'disconnected'

export type DivoConnectionAccess = 'read_only' | 'read_write' | 'admin'

export type DivoPlugin = {
  id: string
  name: string
  category: DivoPluginCategory
  description: string
  icon: ComponentType<{ className?: string }>
  accentClassName: string
  featured?: boolean
  enabled?: boolean
  connectionCount?: number
}

export type DivoConnection = {
  id: string
  pluginId: string
  label: string
  accountEmail: string
  kind: DivoConnectionKind
  status: DivoConnectionStatus
  access: DivoConnectionAccess
  owner: string
  grantedBy?: string
  grantedTo?: string[]
  scopes: string[]
  piAlias: string
  recommendedFor: string
  lastUsedAt: string
}

export type DivoPluginSkill = {
  id: string
  name: string
  description: string
  icon: ComponentType<{ className?: string }>
  verified?: boolean
}

export const divoPlugins: DivoPlugin[] = [
  {
    id: 'browser',
    name: 'My Browser',
    category: 'connector',
    description: 'Run complex tasks safely through your own browser.',
    icon: Chrome,
    accentClassName: 'text-sky-400 bg-sky-400/10 border-sky-400/20',
    featured: true,
    enabled: true,
    connectionCount: 1,
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    category: 'connector',
    description: 'Connect Gmail, Drive, and Calendar accounts.',
    icon: Mail,
    accentClassName: 'text-rose-400 bg-rose-400/10 border-rose-400/20',
    featured: true,
    enabled: true,
  },
  {
    id: 'lark-personal',
    name: 'Lark Personal',
    category: 'connector',
    description: 'Use a local Lark CLI account from this desktop only.',
    icon: MessageSquare,
    accentClassName: 'text-cyan-300 bg-cyan-300/10 border-cyan-300/20',
    featured: true,
    enabled: true,
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'connector',
    description: 'Manage repositories, issues, pull requests, and code changes.',
    icon: Github,
    accentClassName: 'text-neutral-200 bg-neutral-500/10 border-neutral-500/20',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    category: 'connector',
    description: 'Generate and publish posts, stories, and reels.',
    icon: Megaphone,
    accentClassName: 'text-pink-400 bg-pink-400/10 border-pink-400/20',
  },
  {
    id: 'meta-ads',
    name: 'Meta Ads Manager',
    category: 'connector',
    description: 'Automate ad insights and campaign optimization.',
    icon: Megaphone,
    accentClassName: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'connector',
    description: 'Search workspace content, update notes, and automate workflows.',
    icon: FileText,
    accentClassName: 'text-neutral-100 bg-neutral-500/10 border-neutral-500/20',
  },
  {
    id: 'higgsfield',
    name: 'Higgsfield',
    category: 'connector',
    description: 'Create cinematic images and videos with Higgsfield.',
    icon: Sparkles,
    accentClassName: 'text-lime-300 bg-lime-300/10 border-lime-300/20',
  },
]

export const pluginSkills: DivoPluginSkill[] = [
  {
    id: 'google-connection-router',
    name: 'google-connection-router',
    description: 'Choose the right Google connection by account, grant, and task intent.',
    icon: ShieldCheck,
    verified: true,
  },
  {
    id: 'outreach-thread-reader',
    name: 'outreach-thread-reader',
    description: 'Read outreach mailboxes safely without drafting or sending replies.',
    icon: Mail,
    verified: true,
  },
  {
    id: 'drive-research-assistant',
    name: 'drive-research-assistant',
    description: 'Search shared Drive folders and summarize source documents.',
    icon: Search,
  },
  {
    id: 'calendar-availability-planner',
    name: 'calendar-availability-planner',
    description: 'Compare calendars and recommend meeting windows.',
    icon: CalendarDays,
  },
  {
    id: 'sheet-context-builder',
    name: 'sheet-context-builder',
    description: 'Turn spreadsheet ranges into structured context for Pi.',
    icon: FileSpreadsheet,
  },
  {
    id: 'shared-account-admin',
    name: 'shared-account-admin',
    description: 'Help admins grant shared account access with clear approval rules.',
    icon: Users,
  },
]

export const googleWorkspaceServices = [
  { name: 'Gmail', icon: Mail, description: 'Read, search, draft, and send email based on access.' },
  { name: 'Drive', icon: HardDrive, description: 'Search files, inspect metadata, and read shared docs.' },
  { name: 'Calendar', icon: CalendarDays, description: 'Read schedules and create events when allowed.' },
]

export const pluginAutomationCards = [
  {
    title: 'Run complex tasks safely through your own browser.',
    icon: Chrome,
    accentClassName: 'text-sky-400 bg-sky-400/10 border-sky-400/20',
  },
  {
    title: 'Get a personal email assistant for Gmail.',
    icon: Mail,
    accentClassName: 'text-rose-400 bg-rose-400/10 border-rose-400/20',
  },
  {
    title: 'Turn repeat work into reusable skills.',
    icon: Puzzle,
    accentClassName: 'text-violet-300 bg-violet-300/10 border-violet-300/20',
  },
]

export function getPlugin(pluginId: string) {
  return divoPlugins.find((plugin) => plugin.id === pluginId)
}
