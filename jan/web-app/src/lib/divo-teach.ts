import { invoke } from '@tauri-apps/api/core'

export type TeachRecordingFile = {
  path: string
  fileName: string
  mimeType: 'video/mp4' | 'video/quicktime' | 'video/webm'
  size: number
  localOwned: boolean
}

export type TeachSession = {
  id: string
  departmentId: string
  source: 'recording' | 'upload'
  status:
    | 'awaiting_upload'
    | 'queued'
    | 'ingesting'
    | 'ready_for_processing'
    | 'persona_processing'
    | 'persona_updated'
    | 'no_learning'
    | 'failed'
    | 'cancelled'
  progress: number
  originalFileName: string | null
  mimeType: string | null
  fileSize: number | null
  lastError: string | null
  understanding: string | null
  appliedChangeCount: number
  personaRevision: number | null
  remainingUndos: number
  canCancel: boolean
  createdAt: string
  updatedAt: string
}

export type DivoSessionStatus = {
  configured: boolean
  departmentId?: string
}

export const getDivoSessionStatus = () =>
  invoke<DivoSessionStatus>('divo_get_session_status')

export const recordTeachScreen = () =>
  invoke<TeachRecordingFile>('divo_teach_record_screen')

export const cancelTeachRecording = () =>
  invoke<void>('divo_teach_cancel_recording')

export const pickTeachRecording = () =>
  invoke<TeachRecordingFile | null>('divo_teach_pick_recording')

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

export const cancelTeachSession = (sessionId: string) =>
  invoke<TeachSession>('divo_teach_cancel_session', { sessionId })

export const undoManagerPersona = (departmentId: string) =>
  invoke<{ revision: number; remainingUndos: number }>('divo_teach_undo_persona', {
    departmentId,
  })
