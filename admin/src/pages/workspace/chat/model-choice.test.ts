import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileModelSelection, type SelectableModel } from './model-choice'

const models: SelectableModel[] = [
  {
    id: 'deepseek-v4-flash', label: 'Flash', provider: 'deepseek', vision: false,
    reasoningEfforts: ['off', 'high', 'xhigh'], defaultReasoningEffort: 'high',
  },
  {
    id: 'gpt-5.6-luna', label: 'Luna', provider: 'openai', vision: true,
    reasoningEfforts: ['off', 'low', 'medium', 'high'], defaultReasoningEffort: 'high',
  },
]

describe('chat model choice', () => {
  it('starts on Flash even when another allowed model is listed first', () => {
    assert.deepEqual(reconcileModelSelection([...models].reverse(), null), {
      model: 'deepseek-v4-flash', reasoningEffort: 'high',
    })
  })

  it('keeps a real supported preference', () => {
    assert.deepEqual(reconcileModelSelection(models, {
      model: 'gpt-5.6-luna', reasoningEffort: 'medium',
    }), { model: 'gpt-5.6-luna', reasoningEffort: 'medium' })
  })

  it('does not preserve a fake DeepSeek medium control', () => {
    assert.deepEqual(reconcileModelSelection(models, {
      model: 'deepseek-v4-flash', reasoningEffort: 'medium',
    }), { model: 'deepseek-v4-flash', reasoningEffort: 'high' })
  })
})
