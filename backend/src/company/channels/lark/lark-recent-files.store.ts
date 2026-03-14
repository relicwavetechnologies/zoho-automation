/**
 * lark-recent-files.store.ts
 *
 * A lightweight, in-memory, TTL-based register that tracks recently ingested
 * Lark file attachments per conversation (chatId).
 *
 * When a user sends an image or document as a standalone Lark message, it gets
 * ingested and stored here. When the *next* text message arrives from the same
 * chat, the Mastra engine can look up recent files to include them transparently
 * in the AI prompt — allowing users to ask "what is this image?" in a follow-up.
 *
 * TTL is 30 minutes by default: long enough for a natural conversation pace,
 * short enough to not leak stale context into unrelated future chats.
 */

import type { NormalizedAttachedFile } from '../../contracts';
import { orangeDebug } from '../../../utils/orange-debug';

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

type RecentFilesEntry = {
  files: NormalizedAttachedFile[];
  expiresAt: number;
};

class LarkRecentFilesStore {
  private readonly store = new Map<string, RecentFilesEntry>();

  /**
   * Appends newly ingested files to the recent files list for a given chatId.
   * Calling this resets the TTL window for that chat.
   */
  add(chatId: string, files: NormalizedAttachedFile[], ttlMs = DEFAULT_TTL_MS): void {
    if (files.length === 0) return;
    const existing = this.store.get(chatId);
    const merged = existing && existing.expiresAt > Date.now()
      ? [...existing.files, ...files]
      : [...files];

    this.store.set(chatId, {
      files: merged,
      expiresAt: Date.now() + ttlMs,
    });
    orangeDebug('lark.recent_files.add', {
      chatId,
      addedCount: files.length,
      totalCount: merged.length,
      fileAssetIds: merged.map((file) => file.fileAssetId),
      ttlMs,
    });
  }

  /**
   * Returns the current list of recent files for a chatId if they haven't expired.
   * Automatically evicts expired entries.
   */
  get(chatId: string): NormalizedAttachedFile[] {
    const entry = this.store.get(chatId);
    if (!entry) return [];
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(chatId);
      orangeDebug('lark.recent_files.expired', { chatId });
      return [];
    }
    return entry.files;
  }

  /**
   * Returns the pending files for the next text turn and clears them immediately.
   * This prevents stale attachments from leaking into later unrelated prompts.
   */
  consume(chatId: string): NormalizedAttachedFile[] {
    const files = this.get(chatId);
    if (files.length > 0) {
      this.store.delete(chatId);
    }
    orangeDebug('lark.recent_files.consume', {
      chatId,
      fileCount: files.length,
      fileAssetIds: files.map((file) => file.fileAssetId),
    });
    return files;
  }

  /**
   * Clears recent files for a chatId (e.g., after they've been used in a prompt).
   * We do NOT auto-clear after use so that the same file can be asked about multiple times.
   */
  clear(chatId: string): void {
    this.store.delete(chatId);
    orangeDebug('lark.recent_files.clear', { chatId });
  }

  /** Prune all expired entries — call periodically if needed. */
  evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }
}

export const larkRecentFilesStore = new LarkRecentFilesStore();
