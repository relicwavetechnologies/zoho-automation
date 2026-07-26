import { create } from 'zustand'

export type WorkspaceMode = 'ask' | 'teach'

type WorkspaceModeStore = {
  mode: WorkspaceMode
  setMode: (mode: WorkspaceMode) => void
}

/**
 * Which half of the home screen is showing, held app-wide.
 *
 * It was local component state, which meant nothing outside the home route
 * could send the manager back to Teach — including the background indicator,
 * whose entire job is being the way back to work that is still running.
 */
export const useWorkspaceMode = create<WorkspaceModeStore>((set) => ({
  mode: 'ask',
  setMode: (mode) => set({ mode }),
}))
