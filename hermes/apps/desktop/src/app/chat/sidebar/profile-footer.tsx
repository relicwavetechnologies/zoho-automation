import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { SidebarFooter } from '@/components/ui/sidebar'
import {
  companyAccountDisplayName,
  companyAccountMetaLine,
  companyAccountProviderLabel,
  fetchCompanyAccount,
  logoutCompanyAccount
} from '@/lib/company-account'
import { triggerHaptic } from '@/lib/haptics'
import { Loader2 } from '@/lib/icons'

import { PROFILES_ROUTE } from '../../routes'
import { AccountAvatar } from '../../shell/company-account-menu'

// A persistent account block pinned to the bottom of the rail, like Cursor's
// profile footer. Hosts the company (Lark OAuth) identity + sign-out, or falls
// back to the Profiles menu when the desktop isn't connected via OAuth. This is
// the single home for the account menu — it was removed from the titlebar.

// Full-width row that acts as the dropdown trigger. Avatar + two-line identity,
// label hides at the narrow-rail breakpoint (matches the nav rows above).
const ROW_CLASS =
  'flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors duration-100 ease-out select-none hover:bg-(--ui-control-hover-background) focus-visible:bg-(--ui-control-hover-background) focus-visible:outline-none disabled:opacity-70'

const NAME_CLASS = 'block truncate text-[0.8125rem] font-medium leading-tight text-foreground'
const META_CLASS = 'mt-0.5 block truncate text-[0.6875rem] leading-tight text-(--ui-text-tertiary)'

function GenericAvatar() {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
      <Codicon name="account" size="1rem" />
    </span>
  )
}

function AccountRow({ baseUrl }: { baseUrl: string }) {
  const [signingOut, setSigningOut] = useState(false)

  const accountQuery = useQuery({
    enabled: Boolean(baseUrl),
    queryFn: fetchCompanyAccount,
    queryKey: ['company-account', baseUrl],
    refetchOnWindowFocus: true,
    staleTime: 60_000
  })

  const profile = accountQuery.data
  const loading = accountQuery.isLoading && !profile

  const signOut = async () => {
    triggerHaptic('tap')
    setSigningOut(true)

    try {
      await logoutCompanyAccount(baseUrl || undefined)
    } catch {
      setSigningOut(false)
    }
  }

  const name = profile ? companyAccountDisplayName(profile) : 'Account'

  const meta = profile
    ? companyAccountMetaLine(profile) || profile.email || 'Signed in'
    : loading
      ? 'Loading…'
      : 'Not signed in'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className={ROW_CLASS} disabled={signingOut} type="button">
          {loading ? (
            <span className="grid size-7 shrink-0 place-items-center">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </span>
          ) : profile ? (
            <AccountAvatar profile={profile} />
          ) : (
            <GenericAvatar />
          )}
          <span className="min-w-0 flex-1 max-[46.25rem]:hidden">
            <span className={NAME_CLASS}>{name}</span>
            <span className={META_CLASS}>{meta}</span>
          </span>
          <Codicon
            className="shrink-0 text-(--ui-text-tertiary) max-[46.25rem]:hidden"
            name="chevron-up"
            size="0.75rem"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" side="top" sideOffset={8}>
        {profile ? (
          <>
            <DropdownMenuLabel className="space-y-2">
              <div className="flex items-center gap-3">
                <AccountAvatar className="size-10 text-[0.8rem]" profile={profile} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {companyAccountDisplayName(profile)}
                  </div>
                  {profile.email ? (
                    <div className="truncate text-xs font-normal text-muted-foreground">{profile.email}</div>
                  ) : null}
                </div>
              </div>
              <div className="inline-flex rounded-full border border-border px-2 py-0.5 text-[0.68rem] font-medium text-muted-foreground">
                {companyAccountProviderLabel(profile)}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem disabled={signingOut || !profile} onSelect={() => void signOut()}>
          {signingOut ? <Loader2 className="size-4 animate-spin" /> : <Codicon name="sign-out" size="1rem" />}
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ProfilesRow() {
  const navigate = useNavigate()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className={ROW_CLASS} type="button">
          <GenericAvatar />
          <span className="min-w-0 flex-1 max-[46.25rem]:hidden">
            <span className={NAME_CLASS}>Profiles</span>
            <span className={META_CLASS}>Personas &amp; config</span>
          </span>
          <Codicon
            className="shrink-0 text-(--ui-text-tertiary) max-[46.25rem]:hidden"
            name="chevron-up"
            size="0.75rem"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" side="top" sideOffset={8}>
        <DropdownMenuLabel>
          <div className="text-sm font-medium text-foreground">Profiles</div>
          <div className="mt-1 text-xs font-normal leading-4 text-muted-foreground">
            Advanced Hermes environments for separate personas, config, skills, and SOUL.md.
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            triggerHaptic('open')
            navigate(PROFILES_ROUTE)
          }}
        >
          <Codicon name="account" size="1rem" />
          <span>Manage profiles</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function SidebarProfileFooter() {
  const remoteAuthQuery = useQuery({
    queryFn: () => window.hermesDesktop.getRemoteAuthStatus(),
    queryKey: ['remote-auth-status'],
    refetchOnWindowFocus: true,
    staleTime: 30_000
  })

  const status = remoteAuthQuery.data
  const showCompanyAccount = status?.authMode === 'oauth' && status.connected && Boolean(status.baseUrl)

  return (
    <SidebarFooter className="shrink-0 border-t border-(--sidebar-edge-border) p-1.5">
      {showCompanyAccount && status?.baseUrl ? <AccountRow baseUrl={status.baseUrl} /> : <ProfilesRow />}
    </SidebarFooter>
  )
}
