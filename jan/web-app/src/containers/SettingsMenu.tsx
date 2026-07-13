import { Link } from '@tanstack/react-router'
import {
  IconAdjustmentsHorizontal,
  IconCpu,
  IconPalette,
  IconPlugConnected,
} from '@tabler/icons-react'

import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * The Divo desktop exposes only settings that are useful to an API-backed
 * workspace. The underlying Jan settings routes remain registered for
 * compatibility; they are deliberately omitted from this navigation.
 */
const SettingsMenu = () => {
  const { t } = useTranslation()
  const coreSettings = [
    {
      title: 'common:general',
      route: route.settings.general,
      icon: IconAdjustmentsHorizontal,
    },
    {
      title: 'common:appearance',
      route: route.settings.interface,
      icon: IconPalette,
    },
    {
      title: 'common:hardware',
      route: route.settings.hardware,
      icon: IconCpu,
    },
  ]

  return (
    <div className="h-full w-58 shrink-0 overflow-auto px-1.5">
      <div className="flex w-full flex-col gap-1 font-medium">
        {coreSettings.map((menu) => (
          <Link
            key={menu.title}
            to={menu.route}
            className="block w-full cursor-pointer rounded-sm px-2 py-1 hover:bg-secondary hover:dark:bg-secondary/60 [&.active]:bg-secondary [&.active]:dark:bg-secondary/80"
          >
            <div className="flex items-center gap-2">
              <menu.icon size={18} className="shrink-0 text-muted-foreground" />
              <span>{t(menu.title)}</span>
            </div>
          </Link>
        ))}

        <div className="mt-4">
          <span className="px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('common:integrations')}
          </span>
          <Link
            to={route.settings.divo}
            className="mt-1 flex items-center gap-2 rounded-sm px-2 py-1 hover:bg-secondary hover:dark:bg-secondary/60 [&.active]:bg-secondary [&.active]:dark:bg-secondary/80"
          >
            <IconPlugConnected size={18} className="shrink-0 text-muted-foreground" />
            <span>Divo Dex</span>
          </Link>
        </div>
      </div>
    </div>
  )
}

export default SettingsMenu
