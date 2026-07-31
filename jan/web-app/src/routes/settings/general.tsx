import { createFileRoute } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { Card, CardItem } from '@/containers/Card'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { useTranslation } from '@/i18n/react-i18next-compat'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.general as any)({
  component: General,
})

/** General is intentionally informational in Divo Dex. */
function General() {
  const { t } = useTranslation()

  return (
    <div className="flex h-svh w-full flex-col">
      <HeaderPage>
        <span className="w-full text-base font-medium font-studio">
          {t('common:settings')}
        </span>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="w-full overflow-y-auto p-4 pt-0">
          <Card title={t('common:general')}>
            <CardItem
              title={t('settings:general.appVersion')}
              actions={<span className="font-medium text-foreground">v{VERSION}</span>}
            />
          </Card>
        </div>
      </div>
    </div>
  )
}
