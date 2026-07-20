import { ChatComposer } from '@astryxdesign/core/Chat'
import type { ReactNode } from 'react'

/**
 * The Astryx composer chrome, adapted to Divo's composer.
 *
 * ChatInput is 3,056 lines with sixteen store bindings, and almost none of it
 * is chrome — it is slash commands, Pi approvals, skill references, attachment
 * ingestion, drag-drop and IME handling. Astryx's ChatComposer happens to be
 * slot-based, which means the frame can be swapped without any of that moving:
 * every Divo-specific part is passed straight through as a ReactNode.
 *
 * THE ONE RULE THIS ENFORCES: the textarea is OURS. Astryx ships
 * ChatComposerInput, and using it would look like the obvious choice, but our
 * textarea's onChange/onKeyDown carry the `/` menu (which never takes focus of
 * its own), IME composition handling for Safari, row counting and the
 * skill-reference drawer's whole keyboard model. Re-homing that onto a foreign
 * input is a rewrite wearing the costume of a refactor. So `input` takes the
 * existing TextareaAutosize verbatim and Astryx never sees a keystroke.
 *
 * This exists as a separate file rather than inline so the cutover is a
 * reviewable diff against a component that is already proven to render.
 */
export type DivoComposerFrameProps = {
  /** Controlled prompt text, owned by ChatInput. */
  value: string
  onChange: (value: string) => void
  /**
   * Astryx calls this on its own submit affordances. ChatInput already owns
   * Enter-to-send inside the textarea, so this is the button path only.
   */
  onSubmit: (value: string) => void
  onStop?: () => void
  /** True while the thread is busy, which turns send into stop. */
  isStopShown?: boolean
  isDisabled?: boolean
  placeholder?: string
  density?: 'compact' | 'balanced' | 'spacious'
  /** Attachment tokens and skill-reference chips. */
  drawer?: ReactNode
  /** Attach and skill-reference buttons. */
  headerActions?: ReactNode
  /** Context-window usage. */
  headerContext?: ReactNode
  /** Our TextareaAutosize, passed through untouched. */
  input: ReactNode
  /** Model selector and agent-mode toggle. */
  footerActions?: ReactNode
  /** Audio capture. */
  sendActions?: ReactNode
  /** Send/stop, which carries Divo's approval states. */
  sendButton?: ReactNode
  status?: { type: 'error' | 'warning'; message?: string }
}

export function DivoComposerFrame({
  value,
  onChange,
  onSubmit,
  onStop,
  isStopShown = false,
  isDisabled = false,
  placeholder,
  density = 'balanced',
  drawer,
  headerActions,
  headerContext,
  input,
  footerActions,
  sendActions,
  sendButton,
  status,
}: DivoComposerFrameProps) {
  return (
    <ChatComposer
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      onStop={onStop}
      isStopShown={isStopShown}
      isDisabled={isDisabled}
      placeholder={placeholder}
      density={density}
      drawer={drawer}
      headerActions={headerActions}
      headerContext={headerContext}
      input={input}
      footerActions={footerActions}
      sendActions={sendActions}
      sendButton={sendButton}
      status={status}
    />
  )
}
