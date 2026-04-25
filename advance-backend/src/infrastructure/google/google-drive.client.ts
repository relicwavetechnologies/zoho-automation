/**
 * GoogleDriveClient — Google Drive REST API client.
 *
 * Implements GoogleDriveClientPort (defined in google-drive.tool.ts).
 * Takes a pre-resolved access token.
 *
 * API base: https://www.googleapis.com/drive/v3
 */

import type { GoogleDriveClientPort } from '../../application/orchestration/tools/families/google-drive.tool';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

const asRec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export class GoogleDriveClient implements GoogleDriveClientPort {
  constructor(private readonly accessToken: string) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${DRIVE_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Drive API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  private normalizeFile(f: unknown): Record<string, unknown> {
    const r = asRec(f);
    return {
      ...(typeof r['id']           === 'string' ? { fileId:   r['id'] }           : {}),
      ...(typeof r['name']         === 'string' ? { name:     r['name'] }         : {}),
      ...(typeof r['mimeType']     === 'string' ? { mimeType: r['mimeType'] }     : {}),
      ...(typeof r['size']         === 'string' ? { sizeBytes: Number(r['size']) } : {}),
      ...(typeof r['modifiedTime'] === 'string' ? { modifiedAt: r['modifiedTime'] } : {}),
      ...(typeof r['webViewLink']  === 'string' ? { webUrl:   r['webViewLink'] }  : {}),
      ...(typeof r['parents']      !== 'undefined' ? { parents: r['parents'] }    : {}),
    };
  }

  async listFiles(limit = 20): Promise<unknown[]> {
    const params = new URLSearchParams({
      pageSize:  String(Math.min(limit, 100)),
      orderBy:   'modifiedTime desc',
      fields:    'files(id,name,mimeType,size,modifiedTime,webViewLink,parents)',
    });
    const data = await this.call<Record<string, unknown>>(`/files?${params}`);
    const files = Array.isArray(data['files']) ? data['files'] : [];
    return files.map(f => this.normalizeFile(f));
  }

  async getFile(fileId: string): Promise<unknown> {
    const params = new URLSearchParams({
      fields: 'id,name,mimeType,size,modifiedTime,webViewLink,parents,description',
    });
    const data = await this.call<Record<string, unknown>>(`/files/${fileId}?${params}`);
    return this.normalizeFile(data);
  }

  async searchFiles(query: string, limit = 20): Promise<unknown[]> {
    const params = new URLSearchParams({
      q:        `name contains '${query.replace(/'/g, "\\'")}' or fullText contains '${query.replace(/'/g, "\\'")}'`,
      pageSize: String(Math.min(limit, 100)),
      fields:   'files(id,name,mimeType,size,modifiedTime,webViewLink,parents)',
    });
    const data = await this.call<Record<string, unknown>>(`/files?${params}`);
    const files = Array.isArray(data['files']) ? data['files'] : [];
    return files.map(f => this.normalizeFile(f));
  }

  async createFolder(name: string): Promise<{ fileId: string }> {
    const data = await this.call<Record<string, unknown>>('/files', {
      method: 'POST',
      body:   JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });
    const fileId = typeof data['id'] === 'string' ? data['id'] : '';
    if (!fileId) throw new Error('Drive createFolder: response missing file id');
    return { fileId };
  }
}
