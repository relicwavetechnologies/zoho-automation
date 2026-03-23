import { ipcMain } from "electron";
import { net } from "electron";
import { readRuntimeConfig } from "../../shared/runtime-config";

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
    // ignore parse failures
  }
  return bodyText;
};

export function registerThreadHandlers(): void {
  ipcMain.handle("desktop:threads", async (_event, token: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/threads`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok)
      return { success: false, message: await parseBackendError(res) };
    return res.json();
  });

  ipcMain.handle(
    "desktop:thread",
    async (
      _event,
      token: string,
      threadId: string,
      options?: { limit?: number; beforeMessageId?: string },
    ) => {
      const params = new URLSearchParams();
      if (
        typeof options?.limit === "number" &&
        Number.isFinite(options.limit)
      ) {
        params.set("limit", String(options.limit));
      }
      if (options?.beforeMessageId) {
        params.set("beforeMessageId", options.beforeMessageId);
      }
      const query = params.toString();
      const res = await net.fetch(
        `${BACKEND_URL}/api/desktop/threads/${threadId}${query ? `?${query}` : ""}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok)
        return { success: false, message: await parseBackendError(res) };
      return res.json();
    },
  );

  ipcMain.handle(
    "desktop:thread:create",
    async (_event, token: string, payload?: { departmentId?: string }) => {
      const res = await net.fetch(`${BACKEND_URL}/api/desktop/threads`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload ?? {}),
      });
      if (!res.ok)
        return { success: false, message: await parseBackendError(res) };
      return res.json();
    },
  );

  ipcMain.handle(
    "desktop:thread:add-message",
    async (
      _event,
      token: string,
      threadId: string,
      payload: {
        role: string;
        content: string;
        metadata?: Record<string, unknown>;
      },
    ) => {
      const res = await net.fetch(
        `${BACKEND_URL}/api/desktop/threads/${threadId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok)
        return { success: false, message: await parseBackendError(res) };
      return res.json();
    },
  );

  ipcMain.handle(
    "desktop:thread:delete",
    async (_event, token: string, threadId: string) => {
      const res = await net.fetch(
        `${BACKEND_URL}/api/desktop/threads/${threadId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) {
        return { success: false, message: await parseBackendError(res) };
      }
      return { success: true };
    },
  );
}
