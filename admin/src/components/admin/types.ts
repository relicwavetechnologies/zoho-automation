import type { LucideIcon } from "lucide-react"

export type NavSection = {
  label: string
  items: NavItem[]
}

export type NavItem = {
  id: string
  label: string
  path: string
  icon: LucideIcon
}

export type JsonRecord = Record<string, unknown>

export type ApiListState<T> = {
  data: T[]
  loading: boolean
  refreshing: boolean
  error: string | null
  refresh: () => Promise<void>
}
