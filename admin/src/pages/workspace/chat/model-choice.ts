import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  useMyModelOptions,
  type ModelOption,
  type ReasoningEffort,
} from '../data/use-my-activity'

/** The pair that travels with a run. Neither half is decorative. */
export type ModelSelection = {
  model: string
  reasoningEffort: ReasoningEffort
}

export type SelectableModel = ModelOption & {
  reasoningEfforts: readonly ReasoningEffort[]
  defaultReasoningEffort: ReasoningEffort
}

const STORAGE_KEY = 'divo.chat.modelSelection.v1'

/**
 * During a rolling deploy an older backend has no effort metadata. High is the
 * only honest common denominator; offering a larger invented list would bring
 * back the exact fake control this module removes.
 */
function selectable(option: ModelOption): SelectableModel {
  const efforts: readonly ReasoningEffort[] = option.reasoningEfforts?.length
    ? option.reasoningEfforts
    : ['high']
  const preferred: ReasoningEffort = option.defaultReasoningEffort ?? 'high'
  return {
    ...option,
    reasoningEfforts: efforts,
    defaultReasoningEffort: efforts.includes(preferred) ? preferred : efforts[0]!,
  }
}

export function reconcileModelSelection(
  models: readonly SelectableModel[],
  preferred: ModelSelection | null,
): ModelSelection | null {
  if (models.length === 0) return null
  const model = models.find(candidate => candidate.id === preferred?.model)
    ?? models.find(candidate => candidate.id === 'deepseek-v4-flash')
    ?? models[0]!
  const reasoningEffort = preferred
    && model.reasoningEfforts.includes(preferred.reasoningEffort)
    ? preferred.reasoningEffort
    : model.defaultReasoningEffort
  return { model: model.id, reasoningEffort }
}

function readPreference(): ModelSelection | null {
  if (typeof window === 'undefined') return null
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<ModelSelection> | null
    if (!parsed || typeof parsed.model !== 'string' || typeof parsed.reasoningEffort !== 'string') return null
    return parsed as ModelSelection
  } catch {
    return null
  }
}

/** Member-scoped catalogue plus one persistent, valid composer choice. */
export function useChatModelChoice() {
  const available = useMyModelOptions()
  const models = useMemo(
    () => available.allowedModels.map(selectable),
    [available.allowedModels],
  )
  const [preferred, setPreferred] = useState<ModelSelection | null>(readPreference)
  const selection = useMemo(
    () => reconcileModelSelection(models, preferred),
    [models, preferred],
  )

  useEffect(() => {
    if (!selection || typeof window === 'undefined') return
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection)) } catch { /* optional preference */ }
  }, [selection])

  const selectModel = useCallback((model: string) => {
    const option = models.find(candidate => candidate.id === model)
    if (!option) return
    setPreferred({ model, reasoningEffort: option.defaultReasoningEffort })
  }, [models])

  const selectReasoningEffort = useCallback((reasoningEffort: ReasoningEffort) => {
    setPreferred(current => {
      const base = reconcileModelSelection(models, current)
      const option = models.find(candidate => candidate.id === base?.model)
      if (!base || !option?.reasoningEfforts.includes(reasoningEffort)) return current
      return { ...base, reasoningEffort }
    })
  }, [models])

  return {
    ...available,
    models,
    selection,
    selectModel,
    selectReasoningEffort,
  }
}

/**
 * `xhigh` used to read "Max", because it was the only rung above `high` and on
 * every model it carried whatever that provider called its ceiling. Luna has
 * both, so the top rung needs its own word and this one gets its real name.
 */
export function reasoningEffortLabel(effort: ReasoningEffort): string {
  if (effort === 'xhigh') return 'Extra high'
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`
}

export function reasoningEffortHint(effort: ReasoningEffort): string {
  if (effort === 'off') return 'Fastest'
  if (effort === 'minimal' || effort === 'low') return 'Faster'
  if (effort === 'medium') return 'Balanced'
  if (effort === 'high') return 'Thorough'
  if (effort === 'xhigh') return 'Slower'
  return 'Slowest'
}
