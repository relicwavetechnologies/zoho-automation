import type {
  CompleteFollowUpRequest,
  CreateFollowUpRequest,
  CreateFollowUpResponse,
  FollowUpActionRequest,
  FollowUpActionResponse,
  FollowUpDetailResponse,
  ListFollowUpTasksResponse,
  StartFollowUpIntentRequest,
  UpdateFollowUpDocRequest
} from './api-types'
import { FOLLOW_UP_API_PATHS, FollowUpsClientError } from './api-types'
import type { FollowUpsClient } from './client'

function ensureDesktopApi() {
  if (typeof window === 'undefined' || !window.hermesDesktop?.api) {
    throw new FollowUpsClientError('Desktop API bridge unavailable', 'api_unavailable')
  }
  return window.hermesDesktop.api
}

/**
 * HTTP-backed client for Wave 5 bridge endpoints. Not enabled by default;
 * routes are defined here so Dex can swap from mock → API without UI churn.
 */
export function createHttpFollowUpsClient(): FollowUpsClient {
  const api = ensureDesktopApi()

  return {
    createFollowUp(request: CreateFollowUpRequest): Promise<CreateFollowUpResponse> {
      return api<CreateFollowUpResponse>({
        method: 'POST',
        path: FOLLOW_UP_API_PATHS.create,
        body: request
      })
    },

    listTaskMetadata(): Promise<ListFollowUpTasksResponse> {
      return api<ListFollowUpTasksResponse>({ path: FOLLOW_UP_API_PATHS.list })
    },

    getFollowUpDetail(followUpId: string): Promise<FollowUpDetailResponse> {
      return api<FollowUpDetailResponse>({ path: FOLLOW_UP_API_PATHS.detail(followUpId) })
    },

    startFollowUpIntent(request: StartFollowUpIntentRequest): Promise<FollowUpActionResponse> {
      return api<FollowUpActionResponse>({
        method: 'POST',
        path: FOLLOW_UP_API_PATHS.startIntent(request.followUpId),
        body: request.activeSessionId ? { activeSessionId: request.activeSessionId } : {}
      })
    },

    pauseFollowUp(request: FollowUpActionRequest): Promise<FollowUpActionResponse> {
      return api<FollowUpActionResponse>({
        method: 'POST',
        path: FOLLOW_UP_API_PATHS.pause(request.followUpId),
        body: request.reason ? { reason: request.reason } : {}
      })
    },

    updateFollowUpDoc(request: UpdateFollowUpDocRequest): Promise<FollowUpActionResponse> {
      return api<FollowUpActionResponse>({
        method: 'POST',
        path: FOLLOW_UP_API_PATHS.updateDoc(request.followUpId),
        body: { note: request.note.trim() }
      })
    },

    completeFollowUp(request: CompleteFollowUpRequest): Promise<FollowUpActionResponse> {
      return api<FollowUpActionResponse>({
        method: 'POST',
        path: FOLLOW_UP_API_PATHS.complete(request.followUpId),
        body: request.summary ? { summary: request.summary } : {}
      })
    }
  }
}
