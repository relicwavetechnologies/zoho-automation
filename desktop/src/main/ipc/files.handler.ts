import { ipcMain, net } from "electron";
import { readRuntimeConfig } from "../../shared/runtime-config";

const { backendUrl: BACKEND_URL } = readRuntimeConfig();

export function registerFilesHandlers(): void {
  /**
   * Upload a file buffer from the renderer via IPC → main → backend.
   * Uses Electron's net.fetch with native FormData + Blob (supported since Electron 28+).
   * ArrayBuffer is used because it is IPC-serializable; File/FormData are not.
   */
  ipcMain.handle(
    "desktop:files:upload",
    async (
      _event,
      token: string,
      fileBuffer: ArrayBuffer,
      fileName: string,
      mimeType: string,
    ) => {
      try {
        const formData = new FormData();
        const blob = new Blob([fileBuffer], { type: mimeType });
        formData.append("file", blob, fileName);

        const res = await net.fetch(`${BACKEND_URL}/api/member/files/upload`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          // net.fetch in Electron 28+ natively supports FormData with Blob
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          body: formData as any,
        });

        const json = await res.json();
        return { success: res.ok, status: res.status, data: json };
      } catch (error) {
        return {
          success: false,
          status: 0,
          data: {
            message: error instanceof Error ? error.message : "Upload failed",
          },
        };
      }
    },
  );

  ipcMain.handle("desktop:files:list", async (_event, token: string) => {
    try {
      const res = await net.fetch(`${BACKEND_URL}/api/member/files`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      return { success: res.ok, data: json };
    } catch (error) {
      return {
        success: false,
        data: {
          message:
            error instanceof Error ? error.message : "Failed to list files",
        },
      };
    }
  });
  ipcMain.handle(
    "desktop:files:share",
    async (_event, token: string, fileId: string, reason?: string) => {
      try {
        const res = await net.fetch(
          `${BACKEND_URL}/api/member/files/${fileId}/share`,
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
              error instanceof Error ? error.message : "Failed to share file",
          },
        };
      }
    },
  );
  ipcMain.handle(
    "desktop:files:delete",
    async (_event, token: string, fileId: string) => {
      try {
        const res = await net.fetch(
          `${BACKEND_URL}/api/member/files/${fileId}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        const json = await res.json();
        return { success: res.ok, data: json };
      } catch (error) {
        return {
          success: false,
          data: {
            message:
              error instanceof Error ? error.message : "Failed to delete file",
          },
        };
      }
    },
  );

  ipcMain.handle(
    "desktop:files:retry",
    async (_event, token: string, fileId: string) => {
      try {
        const res = await net.fetch(
          `${BACKEND_URL}/api/member/files/${fileId}/retry`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
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
                : "Failed to retry ingestion",
          },
        };
      }
    },
  );
}
