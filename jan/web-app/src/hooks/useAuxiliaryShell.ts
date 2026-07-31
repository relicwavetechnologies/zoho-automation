import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'

type AuxiliaryShellState = {
  open: boolean
  /** Auxiliary panel size as a percentage of the PanelGroup (1–100). */
  sizePercent: number
  setOpen: (open: boolean) => void
  toggle: () => void
  setSizePercent: (size: number) => void
}

const DEFAULT_SIZE = 38
const MIN_SIZE = 22
const MAX_SIZE = 55

export function clampAuxiliarySize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_SIZE
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(size)))
}

export const useAuxiliaryShell = create<AuxiliaryShellState>()(
  persist(
    (set, get) => ({
      open: false,
      sizePercent: DEFAULT_SIZE,
      setOpen: (open) => set({ open }),
      toggle: () => set({ open: !get().open }),
      setSizePercent: (size) => set({ sizePercent: clampAuxiliarySize(size) }),
    }),
    {
      name: localStorageKey.AuxiliaryShell,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        open: state.open,
        sizePercent: state.sizePercent,
      }),
    }
  )
)

export const AUXILIARY_SIZE = {
  default: DEFAULT_SIZE,
  min: MIN_SIZE,
  max: MAX_SIZE,
} as const
