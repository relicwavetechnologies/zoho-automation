import { Sparkles } from "lucide-react"

type LogoMarkProps = {
  collapsed?: boolean
}

export function LogoMark({ collapsed }: LogoMarkProps) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
        <Sparkles className="h-5 w-5" aria-hidden="true" />
      </div>
      {!collapsed ? (
        <div className="min-w-0">
          <p className="font-studio text-sm font-bold uppercase tracking-[0.2em]">Divo</p>
          <p className="text-xs text-muted-foreground">Admin Console</p>
        </div>
      ) : null}
    </div>
  )
}
