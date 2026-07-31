import { create } from 'zustand'

import type {
  TeachLocalRecording,
  TeachRecorderStatus,
  TeachSession,
} from '@/lib/divo-teach'
import {
  summarizeTeachActivity,
  toTeachWorkItems,
  type TeachActivityInput,
  type TeachActivitySummary,
  type TeachWorkItem,
} from '@/lib/teach-activity'

const IDLE_RECORDER: TeachRecorderStatus = {
  recording: false,
  startedAt: null,
  fileName: null,
}

export type TeachActivityStore = {
  recorder: TeachRecorderStatus
  recordings: TeachLocalRecording[]
  sessions: Record<string, TeachSession>
  /** Session ids the Rust backend reports as actively streaming. */
  uploading: string[]
  uploadPercent: Record<string, number>
  /** When each session's progress last actually moved, for stall detection. */
  progressSeenAt: Record<string, number>
  /** False once a backend call fails, true again on the next success. */
  online: boolean
  /** Undefined until the first reconcile lands — distinct from "no work". */
  reconciledAt?: number

  setRecorder: (recorder: TeachRecorderStatus) => void
  setRecordings: (recordings: TeachLocalRecording[]) => void
  setUploading: (sessionIds: string[]) => void
  setUploadPercent: (sessionId: string, percent: number) => void
  setOnline: (online: boolean) => void
  mergeSession: (session: TeachSession) => void
  markReconciled: () => void
  /** Drop a recording immediately after an explicit local delete. */
  forgetRecording: (path: string) => void
}

/**
 * App-wide owner of "is Teach doing anything right now".
 *
 * Teach used to keep all of this inside the route component, which is a mode
 * toggle on the home screen: clicking any other nav item unmounted it and the
 * manager lost every trace of a running recording, an in-flight upload, and a
 * session being processed. The work itself survived in Rust and on the server,
 * but nothing in the UI could still see it. Holding the state here means the
 * Teach screen, the background indicator, and the reconciler are all reading
 * one truth, and closing the screen no longer looks like losing the work.
 */
export const useTeachActivity = create<TeachActivityStore>((set) => ({
  recorder: IDLE_RECORDER,
  recordings: [],
  sessions: {},
  uploading: [],
  uploadPercent: {},
  progressSeenAt: {},
  online: true,

  setRecorder: (recorder) => set({ recorder }),
  setRecordings: (recordings) => set({ recordings }),
  setUploading: (uploading) => set({ uploading }),
  setUploadPercent: (sessionId, percent) =>
    set((state) => ({
      uploadPercent: { ...state.uploadPercent, [sessionId]: percent },
    })),
  setOnline: (online) => set({ online }),
  mergeSession: (session) =>
    set((state) => {
      // Only a real change of progress or status counts as movement. Restamping
      // on every poll would mean a wedged job looked busy forever, which is
      // exactly the state this is here to detect.
      const previous = state.sessions[session.id]
      const moved =
        !previous ||
        previous.progress !== session.progress ||
        previous.status !== session.status
      return {
        sessions: { ...state.sessions, [session.id]: session },
        progressSeenAt: moved
          ? { ...state.progressSeenAt, [session.id]: Date.now() }
          : state.progressSeenAt,
      }
    }),
  markReconciled: () => set({ reconciledAt: Date.now() }),
  forgetRecording: (path) =>
    set((state) => ({
      recordings: state.recordings.filter(
        (recording) => recording.path !== path
      ),
    })),
}))

const toInput = (state: TeachActivityStore): TeachActivityInput => ({
  recorder: state.recorder,
  recordings: state.recordings,
  sessions: state.sessions,
  uploading: state.uploading,
  uploadPercent: state.uploadPercent,
  progressSeenAt: state.progressSeenAt,
  // Read at derive time. The reconciler ticks the store roughly every second
  // while work is in flight, so this stays fresh without its own timer.
  now: Date.now(),
  online: state.online,
})

export const teachActivityInput = () => toInput(useTeachActivity.getState())

/** Every outstanding piece of Teach work, in plain language. */
export function useTeachWorkItems(): TeachWorkItem[] {
  const state = useTeachActivity()
  return toTeachWorkItems({ ...toInput(state), recorder: IDLE_RECORDER })
}

/** The one line worth showing anywhere in the app, or null when idle. */
export function useTeachActivitySummary(): TeachActivitySummary | null {
  const state = useTeachActivity()
  return summarizeTeachActivity(toInput(state))
}
