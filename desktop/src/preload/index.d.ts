import type { DesktopAPI } from './index'

declare global {
  interface Window {
    desktopAPI: DesktopAPI
  }
}
