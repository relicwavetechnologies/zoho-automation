import { invoke } from '@tauri-apps/api/core'

export type TeachRecordingFile = {
  path: string
  fileName: string
  mimeType: 'video/mp4' | 'video/quicktime' | 'video/webm'
  size: number
  localOwned: boolean
}

export type TeachLocalRecording = TeachRecordingFile & {
  sessionId: string | null
  state: 'ready' | 'uploading' | 'processing' | 'agent_ready' | 'retryable'
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type TeachSession = {
  id: string
  departmentId: string
  source: 'recording' | 'upload'
  status:
    | 'awaiting_upload'
    | 'queued'
    | 'ingesting'
    | 'evidence_ready'
    | 'agent_processing'
    | 'completed'
    | 'ready_for_processing'
    | 'persona_processing'
    | 'persona_updated'
    | 'no_learning'
    | 'failed'
    | 'cancelled'
  progress: number
  processingStep:
    | 'awaiting_upload'
    | 'recording_received'
    | 'selecting_evidence'
    | 'transcribing'
    | 'reading_screens'
    | 'reconstructing_workflow'
    | 'evidence_ready'
    | 'agent_reasoning'
    | 'complete'
    | 'failed'
    | 'cancelled'
  originalFileName: string | null
  mimeType: string | null
  fileSize: number | null
  lastError: string | null
  understanding: string | null
  appliedChanges: Array<{
    operation: 'create' | 'merge' | 'replace' | 'retire'
    kind: string
    scopeKey: string
    ruleKey: string
    instruction: string | null
    confidence: number
    evidenceRefs: string[]
  }>
  appliedSkills: Array<{
    id: string
    slug: string
    name: string
    revision: number
    outcome: 'created' | 'updated'
  }>
  evidence: {
    durationSeconds: number | null
    frameCount: number
    transcriptSegmentCount: number
    warningCount: number
    transcriptionProvider: string | null
    transcriptionModel: string | null
    ocrModels: string[]
  } | null
  modelProvider: string | null
  modelId: string | null
  parentSessionId: string | null
  managerCorrection: string | null
  appliedChangeCount: number
  personaRevision: number | null
  remainingUndos: number
  canCancel: boolean
  createdAt: string
  updatedAt: string
}

export type ManagerPersonaTree = {
  revision: number
  updatedAt: string
  nodes: Array<{
    id: string
    kind: string
    scopeKey: string
    ruleKey: string
    instruction: string
    confidence: number
    learningSources: Array<{
      source: 'teach' | 'conversation'
      sourceId: string
      decision: string
      rationale: string
      evidenceRefs: string[]
      learnedAt: string
    }>
    linkedSkills: Array<{
      id: string
      slug: string
      name: string
      summary: string
      revision: number
      toolIds: string[]
    }>
  }>
}

export type DivoSessionStatus = {
  configured: boolean
  departmentId?: string
}

export type TeachRecorderStatus = {
  recording: boolean
  startedAt?: string | null
  fileName?: string | null
}

export const getDivoSessionStatus = () =>
  invoke<DivoSessionStatus>('divo_get_session_status')

export const recordTeachScreen = () =>
  invoke<TeachRecordingFile>('divo_teach_record_screen')

/**
 * Whether the native recorder is running right now.
 *
 * Teach is a mode toggle inside the home route, so its component unmounts as
 * soon as the manager clicks anything else. The recorder lives in Rust and
 * keeps going; this is how a freshly mounted screen finds that out instead of
 * showing an idle launcher over a live recording.
 */
export const getTeachRecorderStatus = () =>
  invoke<TeachRecorderStatus>('divo_teach_recording_status')

/** Stop recording and keep the video. Resolves false if nothing was running. */
export const stopTeachRecording = () =>
  invoke<boolean>('divo_teach_stop_recording')

export const cancelTeachRecording = () =>
  invoke<void>('divo_teach_cancel_recording')

export const pickTeachRecording = () =>
  invoke<TeachRecordingFile | null>('divo_teach_pick_recording')

export const listLocalTeachRecordings = () =>
  invoke<TeachLocalRecording[]>('divo_teach_list_local_recordings')

export const deleteLocalTeachRecording = (path: string) =>
  invoke<void>('divo_teach_delete_local_recording', { path })

export const createTeachSession = (
  departmentId: string,
  source: 'recording' | 'upload',
  recording: TeachRecordingFile
) =>
  invoke<TeachSession>('divo_teach_create_session', {
    departmentId,
    source,
    recording,
  })

/**
 * Whether an upload for this session is streaming right now.
 *
 * Asked of Rust rather than tracked in a module-level Set, because the webview
 * can reload while the upload future keeps running in the backend — which used
 * to leave JavaScript believing the session was idle and start a second
 * concurrent upload of the same recording.
 */
export const isTeachUploadActive = (sessionId: string) =>
  invoke<boolean>('divo_teach_upload_active', { sessionId })

export const uploadTeachRecording = (
  sessionId: string,
  recording: TeachRecordingFile
) =>
  invoke<TeachSession>('divo_teach_upload_recording', {
    sessionId,
    recording,
  })

export const getTeachSession = (sessionId: string) =>
  invoke<TeachSession>('divo_teach_get_session', { sessionId })

export const listRecentTeachLearnings = (departmentId: string, limit = 10) =>
  invoke<TeachSession[]>('divo_teach_list_recent_learnings', { departmentId, limit })

export const getManagerPersonaTree = (departmentId: string) =>
  invoke<ManagerPersonaTree | null>('divo_teach_get_persona_tree', { departmentId })

export const finalizeLocalTeachRecording = (path: string, sessionId: string) =>
  invoke<void>('divo_teach_finalize_local_recording', { path, sessionId })

export const cancelTeachSession = (sessionId: string) =>
  invoke<TeachSession>('divo_teach_cancel_session', { sessionId })

/**
 * Put a session that stopped making progress back in the queue.
 *
 * The server sweeps up stalled ingestions on its own, but deliberately waits
 * ten minutes before assuming one is dead. This is the manager saying "it is
 * clearly stuck, try again now" rather than watching a frozen bar.
 */
export const resumeTeachSession = (sessionId: string) =>
  invoke<TeachSession>('divo_teach_resume_session', { sessionId })

export const undoManagerPersona = (departmentId: string) =>
  invoke<{ revision: number; remainingUndos: number }>('divo_teach_undo_persona', {
    departmentId,
  })
