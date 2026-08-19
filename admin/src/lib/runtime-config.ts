type DivoRuntimeConfig = {
  logoDevPublishableKey?: string
}

declare global {
  interface Window {
    __DIVO_RUNTIME_CONFIG__?: DivoRuntimeConfig
  }
}

export function logoDevPublishableKey(): string {
  if (typeof window !== 'undefined') {
    const runtimeKey = window.__DIVO_RUNTIME_CONFIG__?.logoDevPublishableKey?.trim()
    if (runtimeKey) return runtimeKey
  }
  return (import.meta.env.VITE_LOGO_DEV_PUBLISHABLE_KEY ?? '').trim()
}
