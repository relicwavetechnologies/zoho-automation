import {
  Brain,
  Cpu,
  FileSearch,
  Globe,
  ScanSearch,
  Share2,
  SquareTerminal,
} from 'lucide-react'
import type { ComponentType } from 'react'

import { CanvaIcon, GoogleIcon, LarkIcon, ZohoIcon } from '@/components/brand-icons'
import type { DivoToolInventoryItem } from './divo-tools'

export type ToolPresentationGroup = {
  id: string
  title: string
  description: string
  Icon: ComponentType<{ className?: string }>
  iconClassName?: string
  childTools: DivoToolInventoryItem[]
}

const providers = [
  { id: 'google-workspace', title: 'Google Workspace', description: 'Gmail, Drive, and Calendar tools.', Icon: GoogleIcon, toolIds: ['googleGmail', 'googleDrive', 'googleCalendar'] },
  { id: 'canva', title: 'Canva', description: 'Design, asset, folder, and export tools.', Icon: CanvaIcon, toolIds: ['canvaDesign'] },
  { id: 'zoho', title: 'Zoho', description: 'CRM and Books tools.', Icon: ZohoIcon, iconClassName: 'h-5 w-7', toolIds: ['zohoCrm', 'zohoBooks'] },
  { id: 'lark-personal', title: 'Lark', description: 'Company collaboration tools.', Icon: LarkIcon, toolIds: ['larkMessaging', 'larkContacts', 'larkTask', 'larkCalendar', 'larkDoc', 'larkBase', 'larkApproval'] },
  { id: 'tool-memory', title: 'Memory', description: 'Company memory and knowledge tools.', Icon: Brain, toolIds: ['memoryPublishing', 'memoryRecall'] },
] as const

// Distinct, fitting icons for the standalone capability tools so each card reads
// at a glance instead of falling back to a generic mark.
const toolIcons: Record<string, ComponentType<{ className?: string }>> = {
  dataProcessor: Cpu,
  runCommand: SquareTerminal,
  documentRag: FileSearch,
  skillPublishing: Share2,
  webSearch: Globe,
  contextSearch: ScanSearch,
  memoryRecall: Brain,
  memoryPublishing: Brain,
}

export function groupToolInventory(items: DivoToolInventoryItem[]): ToolPresentationGroup[] {
  const grouped = new Set<string>()
  const groups = providers.flatMap(provider => {
    const childTools = items.filter(item => provider.toolIds.includes(item.tool.toolId as never))
    childTools.forEach(item => grouped.add(item.tool.toolId))
    return childTools.length ? [{ ...provider, childTools }] : []
  })
  return [...groups, ...items.filter(item => !grouped.has(item.tool.toolId)).map(item => ({
    id: `tool-${item.tool.toolId}`, title: item.tool.name, description: item.tool.description, Icon: toolIcons[item.tool.toolId] ?? Brain, childTools: [item],
  }))]
}

export function groupToolsForDetail(items: DivoToolInventoryItem[], id: string): ToolPresentationGroup | null {
  return groupToolInventory(items).find(group => group.id === id) ?? null
}
