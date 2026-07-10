import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  ShieldCheck,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { route } from '@/constants/routes'
import {
  divoPlugins,
  pluginAutomationCards,
  pluginSkills,
} from '@/lib/plugins'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/plugins/' as any)({
  component: PluginsRoute,
})

function PluginsRoute() {
  const navigate = useNavigate()
  const connectors = divoPlugins.filter((plugin) => plugin.category === 'connector')

  return (
    <div className="h-svh min-h-0 overflow-y-auto overscroll-contain bg-background">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-8 lg:px-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-medium tracking-normal">Plugins</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect accounts, shared workspaces, and reusable skills for Divo.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm">
              Manage
              <ChevronRight className="size-4 rotate-90" />
            </Button>
            <Button size="sm">
              Create
              <ChevronRight className="size-4 rotate-90" />
            </Button>
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-3">
          {pluginAutomationCards.map((card) => {
            const Icon = card.icon
            return (
              <div
                key={card.title}
                className="min-h-32 rounded-lg border border-border/70 bg-card/40 p-4"
              >
                <div
                  className={cn(
                    'mb-4 flex size-10 items-center justify-center rounded-md border',
                    card.accentClassName
                  )}
                >
                  <Icon className="size-5" />
                </div>
                <p className="max-w-64 text-base font-medium leading-snug">
                  {card.title}
                </p>
              </div>
            )
          })}
        </section>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-10 rounded-lg border-border/60 bg-muted/50 pl-9"
            placeholder="Search connectors, skills, data sources"
          />
        </div>

        <PluginSection
          title="Connectors"
          description="Connect apps and APIs to share your context."
          actionLabel="View all"
        >
          <div className="grid gap-3 md:grid-cols-2">
            {connectors.map((plugin) => {
              const Icon = plugin.icon
              return (
                <button
                  key={plugin.id}
                  type="button"
                  onClick={() =>
                    navigate({
                      to: route.plugins.detail,
                      params: { pluginId: plugin.id },
                    } as any)
                  }
                  className="group flex min-h-20 items-center gap-3 rounded-lg border border-border/70 bg-card/30 p-3 text-left transition-colors hover:bg-accent/50"
                >
                  <span
                    className={cn(
                      'flex size-10 items-center justify-center rounded-md border',
                      plugin.accentClassName
                    )}
                  >
                    <Icon className={cn('size-5', plugin.iconClassName)} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {plugin.name}
                      {plugin.connectionCount ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                          {plugin.connectionCount}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-1 line-clamp-2 text-sm leading-snug text-muted-foreground">
                      {plugin.description}
                    </span>
                  </span>
                  <span className="flex size-8 items-center justify-center rounded-md border border-border/70 text-muted-foreground group-hover:text-foreground">
                    <Plus className="size-4" />
                  </span>
                </button>
              )
            })}
          </div>
        </PluginSection>

        <PluginSection
          title="Skills"
          description="Turn your know-how into reusable flows."
          actionLabel="View all"
        >
          <div className="grid gap-3 md:grid-cols-2">
            {pluginSkills.map((skill) => {
              const Icon = skill.icon
              return (
                <div
                  key={skill.id}
                  className="flex min-h-20 items-center gap-3 rounded-lg border border-border/70 bg-card/30 p-3"
                >
                  <span className="flex size-10 items-center justify-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground">
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      {skill.name}
                      {skill.verified ? (
                        <ShieldCheck className="size-3.5 text-muted-foreground" />
                      ) : null}
                    </span>
                    <span className="mt-1 line-clamp-2 text-sm leading-snug text-muted-foreground">
                      {skill.description}
                    </span>
                  </span>
                  <Button variant="outline" size="icon-sm" aria-label={`Add ${skill.name}`}>
                    <Plus className="size-4" />
                  </Button>
                </div>
              )
            })}
          </div>
        </PluginSection>
      </main>
    </div>
  )
}

function PluginSection({
  title,
  description,
  actionLabel,
  children,
}: {
  title: string
  description: string
  actionLabel: string
  children: ReactNode
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" aria-label={`Previous ${title}`}>
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Next ${title}`}>
            <ChevronRight className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link to={route.plugins.index}>{actionLabel}</Link>
          </Button>
        </div>
      </div>
      {children}
    </section>
  )
}
