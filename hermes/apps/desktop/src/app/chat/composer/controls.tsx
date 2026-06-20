import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { triggerHaptic } from '@/lib/haptics'
import { Layers3, Loader2, Square } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { ConversationStatus } from './hooks/use-voice-conversation'
import type { ChatBarState, VoiceStatus } from './types'

export const ICON_BTN = 'size-(--composer-control-size) shrink-0 rounded-full'
export const GHOST_ICON_BTN = cn(
  ICON_BTN,
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
)
// Send/voice-conversation primary: solid foreground-on-background circle
// (reads as black-on-white in light mode, white-on-black in dark mode) to
// match the reference composer's high-contrast CTA. Keeps the pill itself
// neutral and lets the action visually dominate the row.
export const PRIMARY_ICON_BTN = cn(
  'size-(--composer-control-primary-size,var(--composer-control-size)) shrink-0 rounded-full p-0',
  'bg-foreground text-background hover:bg-foreground/90',
  'disabled:bg-foreground/30 disabled:text-background disabled:opacity-100'
)

interface ConversationProps {
  active: boolean
  level: number
  muted: boolean
  status: ConversationStatus
  onEnd: () => void
  onStart: () => void
  onStopTurn: () => void
  onToggleMute: () => void
}
export function ComposerControls({
  busy,
  busyAction,
  canSubmit,
  conversation,
  disabled,
  hasComposerPayload,
  state,
  voiceStatus,
  onDictate
}: {
  busy: boolean
  busyAction: 'queue' | 'stop'
  canSubmit: boolean
  conversation: ConversationProps
  disabled: boolean
  hasComposerPayload: boolean
  mode?: 'default' | 'landing'
  state: ChatBarState
  voiceStatus: VoiceStatus
  onDictate: () => void
}) {
  if (conversation.active) {
    return <ConversationPill {...conversation} disabled={disabled} />
  }

  // Cursor-style single right-hand control: one light circular button. It's the
  // mic (dictation) while the composer is empty, and morphs into Send / Stop /
  // Queue once there's a payload or a turn is running. The separate
  // voice-conversation (waveform) button was removed to match the Cursor UI.
  const showDictate = !busy && !hasComposerPayload

  if (showDictate) {
    const recording = voiceStatus === 'recording'
    const transcribing = voiceStatus === 'transcribing'

    return (
      <div className="ml-auto flex shrink-0 items-center gap-(--composer-control-gap)">
        <Button
          aria-label="Dictate"
          className={PRIMARY_ICON_BTN}
          disabled={disabled || !state.voice.enabled || transcribing}
          onClick={() => {
            triggerHaptic(recording ? 'close' : 'open')
            onDictate()
          }}
          size="icon"
          title="Dictate"
          type="button"
        >
          {recording ? (
            <Square className="fill-current" size={12} />
          ) : transcribing ? (
            <Loader2 className="animate-spin" size={16} />
          ) : (
            <Codicon name="mic" size="1.15rem" />
          )}
        </Button>
      </div>
    )
  }

  return (
    <div className="ml-auto flex shrink-0 items-center gap-(--composer-control-gap)">
      <Button
        aria-label={busy ? (busyAction === 'queue' ? 'Queue message' : 'Stop') : 'Send'}
        className={PRIMARY_ICON_BTN}
        disabled={disabled || !canSubmit}
        title={busy ? (busyAction === 'queue' ? 'Queue message' : 'Stop') : 'Send'}
        type="submit"
      >
        {busy ? (
          busyAction === 'queue' ? (
            <Layers3 size={16} />
          ) : (
            <span className="block size-3 rounded-[0.1875rem] bg-current" />
          )
        ) : (
          <Codicon name="arrow-up" size="1rem" />
        )}
      </Button>
    </div>
  )
}

function ConversationPill({
  disabled,
  level,
  muted,
  onEnd,
  onStopTurn,
  onToggleMute,
  status
}: ConversationProps & { disabled: boolean }) {
  const speaking = status === 'speaking'
  const listening = status === 'listening' && !muted

  const label =
    status === 'speaking'
      ? 'Speaking'
      : status === 'transcribing'
        ? 'Transcribing'
        : status === 'thinking'
          ? 'Thinking'
          : muted
            ? 'Muted'
            : 'Listening'

  return (
    <div className="ml-auto flex shrink-0 items-center gap-(--composer-control-gap)">
      <Button
        aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
        aria-pressed={muted}
        className={cn(GHOST_ICON_BTN, 'p-0', muted && 'bg-muted text-muted-foreground')}
        disabled={disabled}
        onClick={() => {
          triggerHaptic('selection')
          onToggleMute()
        }}
        size="icon"
        title={muted ? 'Unmute microphone' : 'Mute microphone'}
        type="button"
        variant="ghost"
      >
        <Codicon name={muted ? 'mic-off' : 'mic'} size="1rem" />
      </Button>
      {listening && (
        <Button
          aria-label="Stop listening and send"
          className="h-(--composer-control-size) shrink-0 gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          disabled={disabled}
          onClick={() => {
            triggerHaptic('submit')
            onStopTurn()
          }}
          title="Stop listening and send"
          type="button"
          variant="ghost"
        >
          <Square className="fill-current" size={11} />
          <span>Stop</span>
        </Button>
      )}
      <Button
        aria-label="End voice conversation"
        className="h-(--composer-control-size) gap-1.5 rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        disabled={disabled}
        onClick={() => {
          triggerHaptic('close')
          onEnd()
        }}
        title="End voice conversation"
        type="button"
      >
        <ConversationIndicator level={level} listening={listening} speaking={speaking} />
        <span>End</span>
      </Button>
      <span className="sr-only" role="status">
        {label}
      </span>
    </div>
  )
}

function ConversationIndicator({
  level,
  listening,
  speaking
}: {
  level: number
  listening: boolean
  speaking: boolean
}) {
  if (speaking) {
    return <Loader2 className="animate-spin" size={12} />
  }

  const bars = [0.55, 0.85, 1, 0.85, 0.55]
  const normalized = Math.max(0, Math.min(level, 1))

  return (
    <span aria-hidden="true" className="flex h-3 items-center gap-0.5">
      {bars.map((weight, index) => {
        const height = listening ? 0.3 + Math.min(0.7, normalized * weight) : 0.3

        return <span className="w-0.5 rounded-full bg-current" key={index} style={{ height: `${height * 100}%` }} />
      })}
    </span>
  )
}
