import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'

/**
 * Divo model preference for the Pi runtime.
 *
 * The backend proxy is authoritative over which models a member may use
 * (admin-governed `allowedModels`). This store:
 *  - fetches the member's allowed models on demand (`refreshOptions`),
 *  - remembers the user's chosen model locally,
 *  - pushes the choice into the running Pi runtime via `pi_set_model`, and
 *  - re-applies it after each `pi_start` (`applyToRuntime`).
 *
 * The input-bar toggle is shown only when more than one model is allowed.
 */

export const DIVO_MODELS = {
  'deepseek-v4-flash': { label: 'Flash', hint: 'Fast — everyday tasks' },
  'deepseek-v4-pro': { label: 'Pro', hint: 'Deeper reasoning' },
} as const

export type DivoModelId = keyof typeof DIVO_MODELS

/** Pi's provider id for these models; the proxy canonicalizes the model id. */
const DIVO_MODEL_PROVIDER = 'deepseek'
const DEFAULT_MODEL: DivoModelId = 'deepseek-v4-flash'
const STORAGE_KEY = 'divo.preferredModel'

function isDivoModelId(value: string): value is DivoModelId {
  return value in DIVO_MODELS
}

function readStoredModel(): DivoModelId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && isDivoModelId(stored)) return stored
  } catch {
    /* ignore */
  }
  return DEFAULT_MODEL
}

async function pushModelToRuntime(model: DivoModelId): Promise<void> {
  // Pass both camelCase and snake_case so the Tauri command binds regardless of
  // argument-casing conventions (matches the pi_prompt call convention).
  await invoke('pi_set_model', {
    provider: DIVO_MODEL_PROVIDER,
    modelId: model,
    model_id: model,
  })
}

type DivoModelState = {
  /** Models this member may use. One entry → no toggle is shown. */
  allowedModels: DivoModelId[]
  /** The currently preferred model. */
  selectedModel: DivoModelId
  /** True once options have been fetched at least once. */
  loaded: boolean
  refreshOptions: () => Promise<void>
  setModel: (model: DivoModelId) => Promise<void>
  applyToRuntime: () => Promise<void>
}

export const useDivoModel = create<DivoModelState>((set, get) => ({
  allowedModels: [DEFAULT_MODEL],
  selectedModel: readStoredModel(),
  loaded: false,

  refreshOptions: async () => {
    try {
      const res = await invoke<{
        data?: { allowedModels?: string[] }
        allowedModels?: string[]
      }>('divo_get_model_options')
      const raw = res?.data?.allowedModels ?? res?.allowedModels ?? []
      const allowed = raw.filter(isDivoModelId)
      const allowedModels: DivoModelId[] = allowed.length ? allowed : [DEFAULT_MODEL]
      set((state) => {
        // Keep the selection valid: if the stored choice is no longer allowed,
        // fall back to the first allowed model.
        const selectedModel = allowedModels.includes(state.selectedModel)
          ? state.selectedModel
          : allowedModels[0]!
        if (selectedModel !== state.selectedModel) {
          try {
            localStorage.setItem(STORAGE_KEY, selectedModel)
          } catch {
            /* ignore */
          }
        }
        return { allowedModels, selectedModel, loaded: true }
      })
    } catch {
      // No options endpoint / not signed in → keep the Flash-only default so no
      // toggle is shown. The proxy still enforces access on the actual request.
      set({ loaded: true })
    }
  },

  setModel: async (model) => {
    if (!get().allowedModels.includes(model)) return
    try {
      localStorage.setItem(STORAGE_KEY, model)
    } catch {
      /* ignore */
    }
    set({ selectedModel: model })
    try {
      await pushModelToRuntime(model)
    } catch {
      // Pi may not be running yet; the choice is re-applied on the next start.
    }
  },

  applyToRuntime: async () => {
    try {
      await pushModelToRuntime(get().selectedModel)
    } catch {
      /* best-effort */
    }
  },
}))
