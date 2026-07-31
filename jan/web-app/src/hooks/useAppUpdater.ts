import { isDev } from '@/lib/utils'
import { useState, useCallback, useEffect, useRef } from 'react'
import { events, AppEvent } from '@janhq/core'
import type { UpdateInfo } from '@/services/updater/types'
import { SystemEvent } from '@/types/events'
import { getServiceHub } from '@/hooks/useServiceHub'

export interface UpdateState {
  isUpdateAvailable: boolean
  updateInfo: UpdateInfo | null
  isDownloading: boolean
  downloadProgress: number
  downloadedBytes: number
  totalBytes: number
  remindMeLater: boolean
  /** An update is staged on disk and waiting for the user to restart. */
  isReadyToRestart: boolean
  isRestarting: boolean
}

export const useAppUpdater = () => {
  const [updateState, setUpdateState] = useState<UpdateState>({
    isUpdateAvailable: false,
    updateInfo: null,
    isDownloading: false,
    downloadProgress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    remindMeLater: false,
    isReadyToRestart: false,
    isRestarting: false,
  })

  // Mirrors isReadyToRestart so callbacks can read it without depending on
  // (and being recreated by) the state they are guarding against.
  const readyToRestartRef = useRef(false)
  useEffect(() => {
    readyToRestartRef.current = updateState.isReadyToRestart
  }, [updateState.isReadyToRestart])

  // Listen for app update state sync events
  useEffect(() => {
    const handleUpdateStateSync = (newState: Partial<UpdateState>) => {
      setUpdateState((prev) => ({
        ...prev,
        ...newState,
      }))
    }

    events.on('onAppUpdateStateSync', handleUpdateStateSync)

    return () => {
      events.off('onAppUpdateStateSync', handleUpdateStateSync)
    }
  }, [])

  const syncStateToOtherInstances = useCallback(
    (partialState: Partial<UpdateState>) => {
      // Emit event to sync state across all useAppUpdater instances
      events.emit('onAppUpdateStateSync', partialState)
    },
    []
  )

  const checkForUpdate = useCallback(
    async (resetRemindMeLater = false) => {
      console.log('Checking for updates...')

      try {
        // Reset remindMeLater if requested (e.g., when called from settings)
        if (resetRemindMeLater && !AUTO_UPDATER_DISABLED) {
          const newState = {
            remindMeLater: false,
          }
          setUpdateState((prev) => ({
            ...prev,
            ...newState,
          }))
          // Sync to other instances
          syncStateToOtherInstances(newState)
        }

        if (!isDev()) {
          // Production mode - use actual Tauri updater
          const update = await getServiceHub().updater().check()

          if (update) {
            if (AUTO_UPDATER_DISABLED) {
              console.log('Auto updater is disabled')
              return null
            }

            const newState = {
              isUpdateAvailable: true,
              remindMeLater: false,
              updateInfo: update,
            }
            setUpdateState((prev) => ({
              ...prev,
              ...newState,
            }))
            // Sync to other instances
            syncStateToOtherInstances(newState)
            console.log('Update available:', update.version)
            return update
          } else {
            // No update available - reset state, unless one is already staged
            // and waiting on a restart. Clearing it there would drop the restart
            // prompt while the downloaded update still sits on disk.
            if (!readyToRestartRef.current) {
              const newState = {
                isUpdateAvailable: false,
                updateInfo: null,
              }
              setUpdateState((prev) => ({
                ...prev,
                ...newState,
              }))
              // Sync to other instances
              syncStateToOtherInstances(newState)
            }
            return null
          }
        } else {
          const newState = {
            isUpdateAvailable: false,
            updateInfo: null,
            ...(resetRemindMeLater && { remindMeLater: false }),
          }
          setUpdateState((prev) => ({
            ...prev,
            ...newState,
          }))
          // Sync to other instances
          syncStateToOtherInstances(newState)
          return null
        }
      } catch (error) {
        console.error('Error checking for updates:', error)
        // Reset state on error
        const newState = {
          isUpdateAvailable: false,
          updateInfo: null,
        }
        setUpdateState((prev) => ({
          ...prev,
          ...newState,
        }))
        // Sync to other instances
        syncStateToOtherInstances(newState)
        return null
      }
    },
    [syncStateToOtherInstances]
  )

  const setRemindMeLater = useCallback(
    (remind: boolean) => {
      const newState = {
        remindMeLater: remind,
      }
      setUpdateState((prev) => ({
        ...prev,
        ...newState,
      }))
      // Sync to other instances
      syncStateToOtherInstances(newState)
    },
    [syncStateToOtherInstances]
  )

  const downloadUpdate = useCallback(async () => {
    if (AUTO_UPDATER_DISABLED) {
      console.log('Auto updater is disabled')
      return
    }

    if (!updateState.updateInfo) return

    try {
      setUpdateState((prev) => ({
        ...prev,
        isDownloading: true,
      }))

      let downloaded = 0
      let contentLength = 0

      // Only stage the update here. Models and sidecars keep running: the
      // installed app is untouched until the user chooses to restart, so there
      // is no reason to interrupt their work to fetch bytes in the background.
      await getServiceHub().updater().downloadWithProgress((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data?.contentLength || 0
            setUpdateState((prev) => ({
              ...prev,
              totalBytes: contentLength,
            }))
            console.log(`Started downloading ${contentLength} bytes`)

            // Emit app update download started event
            events.emit(AppEvent.onAppUpdateDownloadUpdate, {
              progress: 0,
              downloadedBytes: 0,
              totalBytes: contentLength,
            })
            break
          case 'Progress': {
            downloaded += event.data?.chunkLength || 0
            const progress = contentLength > 0 ? downloaded / contentLength : 0
            setUpdateState((prev) => ({
              ...prev,
              downloadProgress: progress,
              downloadedBytes: downloaded,
            }))
            console.log(`Downloaded ${downloaded} from ${contentLength}`)

            // Emit app update download progress event
            events.emit(AppEvent.onAppUpdateDownloadUpdate, {
              progress: progress,
              downloadedBytes: downloaded,
              totalBytes: contentLength,
            })
            break
          }
          case 'Finished': {
            console.log('Download finished')
            const finishedState = {
              isDownloading: false,
              downloadProgress: 1,
              isReadyToRestart: true,
              // The staged update is the reason to surface the prompt again,
              // so an earlier "remind me later" must not keep it hidden.
              remindMeLater: false,
            }
            setUpdateState((prev) => ({
              ...prev,
              ...finishedState,
            }))
            syncStateToOtherInstances(finishedState)

            // Emit app update download success event
            events.emit(AppEvent.onAppUpdateDownloadSuccess, {})
            break
          }
        }
      })

      console.log('Update staged; waiting for the user to restart')
    } catch (error) {
      console.error('Error downloading update:', error)
      setUpdateState((prev) => ({
        ...prev,
        isDownloading: false,
      }))

      // Emit app update download error event
      events.emit(AppEvent.onAppUpdateDownloadError, {
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }, [updateState.updateInfo, syncStateToOtherInstances])

  const restartToUpdate = useCallback(async () => {
    if (AUTO_UPDATER_DISABLED) {
      console.log('Auto updater is disabled')
      return
    }

    try {
      setUpdateState((prev) => ({ ...prev, isRestarting: true }))

      // Installing swaps the app bundle, so shut inference down first rather
      // than leaving sidecars pointed at binaries that are about to move.
      await getServiceHub().models().stopAllModels()
      getServiceHub().events().emit(SystemEvent.KILL_SIDECAR)
      await new Promise((resolve) => setTimeout(resolve, 1000))

      await getServiceHub().updater().installPendingUpdate()
      await window.core?.api?.relaunch()

      console.log('Update installed')
    } catch (error) {
      console.error('Error installing update:', error)
      // Keep the update staged so the user can retry the restart.
      setUpdateState((prev) => ({ ...prev, isRestarting: false }))

      events.emit(AppEvent.onAppUpdateDownloadError, {
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }, [])

  return {
    updateState,
    checkForUpdate,
    downloadUpdate,
    restartToUpdate,
    setRemindMeLater,
  }
}
