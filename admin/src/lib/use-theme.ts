import { useCallback, useEffect, useState } from "react"

export type Theme = "light" | "dark" | "system"

const STORAGE_KEY = "divo_admin_theme"
const QUERY = "(prefers-color-scheme: dark)"

const readStored = (): Theme => {
  if (typeof window === "undefined") return "system"
  const v = localStorage.getItem(STORAGE_KEY)
  return v === "light" || v === "dark" || v === "system" ? v : "system"
}

const applyClass = (resolved: "light" | "dark") => {
  const root = document.documentElement
  if (resolved === "dark") root.classList.add("dark")
  else root.classList.remove("dark")
}

const resolve = (theme: Theme): "light" | "dark" => {
  if (theme === "system") {
    return typeof window !== "undefined" && window.matchMedia(QUERY).matches ? "dark" : "light"
  }
  return theme
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readStored)
  const [resolved, setResolved] = useState<"light" | "dark">(() => resolve(readStored()))

  // Apply class + resolved on theme change
  useEffect(() => {
    const r = resolve(theme)
    setResolved(r)
    applyClass(r)
    localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])

  // Listen to system preference when theme === "system"
  useEffect(() => {
    if (theme !== "system") return
    const mql = window.matchMedia(QUERY)
    const handler = (e: MediaQueryListEvent) => {
      const r: "light" | "dark" = e.matches ? "dark" : "light"
      setResolved(r)
      applyClass(r)
    }
    mql.addEventListener("change", handler)
    return () => mql.removeEventListener("change", handler)
  }, [theme])

  const setTheme = useCallback((next: Theme) => setThemeState(next), [])

  const toggle = useCallback(() => {
    setThemeState((prev) => (prev === "light" ? "dark" : prev === "dark" ? "system" : "light"))
  }, [])

  return { theme, resolved, setTheme, toggle }
}
