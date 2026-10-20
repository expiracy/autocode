import type { Context, ToastOptions } from "@opencode/plugin/tui/context";

export function showToast(ctx: Context, options: ToastOptions): void {
  try { ctx.ui.toast.show(options); }
  catch {
    // Host notifications must not turn completed mutations into retryable failures.
  }
}
