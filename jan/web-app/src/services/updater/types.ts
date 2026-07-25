/**
 * Updater Service Types
 * Types for application update operations
 */

export interface UpdateInfo {
  version: string
  date?: string
  body?: string
  signature?: string
}

export interface UpdateProgressEvent {
  event: 'Started' | 'Progress' | 'Finished'
  data?: {
    contentLength?: number
    chunkLength?: number
  }
}

export interface UpdaterService {
  check(): Promise<UpdateInfo | null>
  installAndRestart(): Promise<void>
  downloadAndInstallWithProgress(
    progressCallback: (event: UpdateProgressEvent) => void
  ): Promise<void>
  /**
   * Stage an update without installing it. The downloaded update is retained so
   * a later installPendingUpdate() can apply it once the user agrees to restart.
   */
  downloadWithProgress(
    progressCallback: (event: UpdateProgressEvent) => void
  ): Promise<void>
  /** Apply an update staged by downloadWithProgress(). */
  installPendingUpdate(): Promise<void>
  /** Whether an update has been staged and is waiting for a restart. */
  hasPendingUpdate(): boolean
}
