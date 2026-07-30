import type { LarkMeetingClientPort } from '../../../../application/tools/families/lark-meeting.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

type LarkRecord = Record<string, unknown>;

/**
 * Lark Video Conferencing adapter.
 *
 * The official SDK exposes this family as `client.vc.v1.meeting`; this adapter
 * uses the SDK's documented low-level request method so Divo keeps one
 * provider boundary shared by all Lark tool families. It never receives a
 * credential except the short-lived token selected by Divo's connection layer.
 */
export class LarkMeetingClient implements LarkMeetingClientPort {
  private readonly http: LarkHttpClient;

  constructor(deps: LarkHttpClientDeps) {
    this.http = new LarkHttpClient(deps);
  }

  async searchMeetings(input: {
    query?: string;
    startTime?: string;
    endTime?: string;
    limit?: number;
  }): Promise<unknown[]> {
    type SearchResponse = { items?: LarkRecord[] };
    const meetingFilter = input.startTime && input.endTime
      ? { start_time: { start_time: input.startTime, end_time: input.endTime } }
      : undefined;
    const data = await this.http.request<SearchResponse>(
      'POST',
      '/open-apis/vc/v1/meetings/search',
      {
        query: { page_size: Math.min(50, Math.max(1, input.limit ?? 20)) },
        body: {
          ...(input.query ? { query: input.query } : {}),
          ...(meetingFilter ? { meeting_filter: meetingFilter } : {}),
        },
      },
    );
    return data.items ?? [];
  }

  async getMeeting(meetingId: string): Promise<unknown> {
    type MeetingResponse = { meeting?: LarkRecord };
    const data = await this.http.request<MeetingResponse>(
      'GET',
      `/open-apis/vc/v1/meetings/${encodeURIComponent(meetingId)}`,
    );
    return data.meeting ?? data;
  }

  async getRecording(meetingId: string): Promise<unknown> {
    type RecordingResponse = { recording?: LarkRecord };
    const data = await this.http.request<RecordingResponse>(
      'GET',
      `/open-apis/vc/v1/meetings/${encodeURIComponent(meetingId)}/recording`,
    );
    return data.recording ?? data;
  }
}
