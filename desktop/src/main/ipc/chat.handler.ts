import { ipcMain, net } from "electron";

import { readRuntimeConfig } from "../../shared/runtime-config";
import { backendLiveClient } from "../services/backend-live.client";

const { backendUrl: BACKEND_URL } = readRuntimeConfig();

const parseBackendError = async (
  res: Awaited<ReturnType<typeof net.fetch>>,
): Promise<string> => {
  const bodyText = await res.text();
  if (!bodyText) {
    return `Request failed (${res.status})`;
  }
  try {
    const parsed = JSON.parse(bodyText) as {
      message?: string;
      details?: unknown;
      requestId?: string;
    };
    if (parsed.message) {
      const parts = [parsed.message];
      if (parsed.details)
        parts.push(
          typeof parsed.details === "string"
            ? parsed.details
            : JSON.stringify(parsed.details),
        );
      if (parsed.requestId) parts.push(`requestId=${parsed.requestId}`);
      return `${parts.join(" · ")} (HTTP ${res.status})`;
    }
  } catch {
    // fall through
  }
  return bodyText;
};

export function registerChatHandlers(): void {
  ipcMain.handle(
    "desktop:chat:send",
    async (
      _event,
      token: string,
      threadId: string,
      message: string,
      workflowInvocation?: {
        workflowId: string;
        workflowName?: string;
        overrideText?: string;
      },
    ) => {
      const res = await net.fetch(
        `${BACKEND_URL}/api/desktop/chat/${threadId}/send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ message, workflowInvocation }),
        },
      );
      if (!res.ok) {
        return { success: false, message: await parseBackendError(res) };
      }
      return res.json();
    },
  );

  ipcMain.handle(
    "desktop:chat:act",
    async (
      _event,
      token: string,
      threadId: string,
      payload: Record<string, unknown>,
    ) => {
      const res = await net.fetch(
        `${BACKEND_URL}/api/desktop/chat/${threadId}/act`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        return { success: false, message: await parseBackendError(res) };
      }
      return res.json();
    },
  );

  ipcMain.handle(
    "desktop:chat:resolveHitlAction",
    async (
      _event,
      token: string,
      threadId: string,
      actionId: string,
      decision: "confirmed" | "cancelled",
    ) => {
      const res = await net.fetch(
        `${BACKEND_URL}/api/desktop/chat/${threadId}/hitl/${actionId}/decision`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ decision }),
        },
      );
      if (!res.ok) {
        return { success: false, message: await parseBackendError(res) };
      }
      return res.json();
    },
  );

  ipcMain.handle(
    "desktop:chat:actStream",
    async (
      _event,
      token: string,
      threadId: string,
      requestId: string,
      payload: Record<string, unknown>,
    ) => {
      return backendLiveClient.startActStream({
        token,
        requestId,
        threadId,
        payload,
        workspace:
          payload.workspace &&
          typeof payload.workspace === "object" &&
          !Array.isArray(payload.workspace) &&
          typeof (payload.workspace as { name?: unknown }).name === "string" &&
          typeof (payload.workspace as { path?: unknown }).path === "string"
            ? {
                name: (payload.workspace as { name: string }).name,
                path: (payload.workspace as { path: string }).path,
              }
            : null,
      });
    },
  );

  ipcMain.handle(
    "desktop:chat:share",
    async (_event, token: string, threadId: string, reason?: string) => {
      try {
        const res = await net.fetch(
          `${BACKEND_URL}/api/desktop/chat/${threadId}/share`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(reason ? { reason } : {}),
          },
        );
        const json = await res.json();
        return { success: res.ok, data: json };
      } catch (error) {
        return {
          success: false,
          data: {
            message:
              error instanceof Error
                ? error.message
                : "Failed to share conversation",
          },
        };
      }
    },
  );

  ipcMain.handle(
    "desktop:chat:startStream",
    async (
      _event,
      token: string,
      threadId: string,
      message: string,
      requestId: string,
      attachedFiles?: Array<{
        fileAssetId: string;
        cloudinaryUrl: string;
        mimeType: string;
        fileName: string;
      }>,
      mode?: "fast" | "high",
      workspace?: { name: string; path: string },
      workflowInvocation?: {
        workflowId: string;
        workflowName?: string;
        overrideText?: string;
      },
    ) => {
      return backendLiveClient.startChatStream({
        token,
        requestId,
        threadId,
        message,
        attachedFiles,
        mode,
        workspace: workspace ?? null,
        workflowInvocation,
      });
    },
  );

  ipcMain.handle(
    "desktop:chat:sendMessageStream",
    async (
      _event,
      payload: {
        token: string;
        requestId: string;
        threadId: string;
        message: string;
        attachedFiles?: Array<{
          fileAssetId: string;
          cloudinaryUrl: string;
          mimeType: string;
          fileName: string;
        }>;
        mode?: "fast" | "high";
        companyId?: string;
        workspace?: { name: string; path: string };
        workflowInvocation?: {
          workflowId: string;
          workflowName?: string;
          overrideText?: string;
        };
      },
    ) => {
      return backendLiveClient.startChatStream({
        token: payload.token,
        requestId: payload.requestId,
        threadId: payload.threadId,
        message: payload.message,
        attachedFiles: payload.attachedFiles,
        mode: payload.mode,
        workspace: payload.workspace ?? null,
        workflowInvocation: payload.workflowInvocation,
      });
    },
  );

  ipcMain.handle(
    "desktop:chat:stopStream",
    async (_event, requestId: string) => {
      return backendLiveClient.cancelStream(requestId);
    },
  );

  ipcMain.handle(
    "desktop:chat:updateLivePresence",
    async (
      _event,
      token: string,
      workspace?: { name: string; path: string } | null,
    ) => {
      try {
        await backendLiveClient.ensureConnected(token, workspace ?? null);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to connect desktop live session",
        };
      }
    },
  );

  ipcMain.handle("desktop:chat:disconnectLivePresence", async () => {
    backendLiveClient.disconnect();
    return { success: true };
  });

  ipcMain.handle(
    "desktop:chat:stream-url",
    (_event, token: string, threadId: string) => {
      return {
        url: `${BACKEND_URL}/api/desktop/chat/${threadId}/stream`,
        token,
      };
    },
  );

  ipcMain.handle(
    "desktop:fetch",
    async (
      _event,
      url: string,
      options: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      },
    ) => {
      const res = await net.fetch(
        url.startsWith("http") ? url : `${BACKEND_URL}${url}`,
        {
          method: options.method ?? "GET",
          headers: options.headers ?? {},
          body: options.body,
        },
      );
      const text = await res.text();
      return { status: res.status, body: text };
    },
  );
}
