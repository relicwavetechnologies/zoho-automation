import type { ReactNode } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { LogoMark } from "@/components/admin/logo-mark"

type AuthCardProps = {
  title: string
  description: string
  children: ReactNode
}

export function AuthCard({ title, description, children }: AuthCardProps) {
  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl items-center gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <section className="hidden space-y-8 lg:block">
          <LogoMark />
          <div className="space-y-4">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-accent">Control plane</p>
            <h1 className="max-w-xl text-5xl font-semibold tracking-tight">A calmer command center for Divo operations.</h1>
            <p className="max-w-lg text-base leading-7 text-muted-foreground">
              Workspace access, runtime observability, integrations, and governance are now presented through one coherent admin surface.
            </p>
          </div>
          <div className="grid max-w-lg grid-cols-2 gap-3">
            <div className="rounded-2xl bg-emphasis p-5 text-emphasis-foreground">
              <p className="text-3xl font-semibold">8px</p>
              <p className="mt-2 text-sm opacity-70">Radius rhythm</p>
            </div>
            <div className="rounded-2xl bg-accent p-5 text-accent-foreground">
              <p className="text-3xl font-semibold">Live</p>
              <p className="mt-2 text-sm opacity-70">Admin APIs only</p>
            </div>
          </div>
        </section>
        <Card className="rounded-2xl shadow-soft mx-auto w-full max-w-md">
          <CardContent className="p-8">
            <div className="mb-8 space-y-2">
              <div className="lg:hidden">
                <LogoMark />
              </div>
              <h2 className="text-3xl font-semibold tracking-tight">{title}</h2>
              <p className="text-sm leading-6 text-muted-foreground">{description}</p>
            </div>
            {children}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
