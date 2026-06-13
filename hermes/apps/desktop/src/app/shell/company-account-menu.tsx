import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  companyAccountDisplayName,
  companyAccountInitials,
  companyAccountMetaLine,
  type CompanyAccountProfile,
  companyAccountProviderLabel,
  fetchCompanyAccount,
  logoutCompanyAccount
} from '@/lib/company-account'
import { triggerHaptic } from '@/lib/haptics'
import { Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { titlebarButtonClass } from './titlebar'

interface CompanyAccountMenuProps {
  baseUrl: string | null
}

export function AccountAvatar({
  profile,
  className
}: {
  profile: CompanyAccountProfile
  className?: string
}) {
  const initials = companyAccountInitials(profile)

  if (profile.avatar_url) {
    return (
      <img
        alt=""
        className={cn('size-7 rounded-full object-cover', className)}
        src={profile.avatar_url}
      />
    )
  }

  return (
    <span
      className={cn(
        'flex size-7 items-center justify-center rounded-full bg-primary/15 text-[0.68rem] font-semibold text-primary',
        className
      )}
    >
      {initials}
    </span>
  )
}

export function CompanyAccountMenu({ baseUrl }: CompanyAccountMenuProps) {
  const [signingOut, setSigningOut] = useState(false)

  const accountQuery = useQuery({
    queryKey: ['company-account', baseUrl],
    queryFn: fetchCompanyAccount,
    enabled: Boolean(baseUrl),
    staleTime: 60_000,
    refetchOnWindowFocus: true
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Company account"
          className={cn(titlebarButtonClass, 'bg-transparent select-none px-1.5')}
          disabled={loading || signingOut}
          onPointerDown={event => event.stopPropagation()}
          size="icon-titlebar"
          title="Company account"
          type="button"
          variant="ghost"
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : profile ? (
            <AccountAvatar profile={profile} />
          ) : (
            <Codicon name="account" size="1rem" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72" sideOffset={8}>
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
              {companyAccountMetaLine(profile) ? (
                <div className="text-xs font-normal leading-4 text-muted-foreground">
                  {companyAccountMetaLine(profile)}
                </div>
              ) : null}
              <div className="inline-flex rounded-full border border-border px-2 py-0.5 text-[0.68rem] font-medium text-muted-foreground">
                {companyAccountProviderLabel(profile)}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        ) : (
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {accountQuery.isError ? 'Could not load company profile.' : 'Loading company profile…'}
          </DropdownMenuLabel>
        )}
        <DropdownMenuItem disabled={signingOut || !profile} onSelect={() => void signOut()}>
          {signingOut ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Codicon name="sign-out" size="1rem" />
          )}
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
