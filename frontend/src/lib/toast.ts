import { toast } from "sonner";

const toastStyle = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border-default)",
  color: "var(--text-primary)",
};

export const uiToast = {
  success: (message: string) =>
    toast.success(message, {
      style: toastStyle,
      duration: 2500,
    }),
  error: (message: string) =>
    toast.error(message, {
      style: {
        ...toastStyle,
        border: "1px solid var(--error)",
      },
      duration: 3500,
    }),
  info: (message: string) =>
    toast.message(message, {
      style: toastStyle,
      duration: 2200,
    }),
};
