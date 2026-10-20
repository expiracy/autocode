import { showToast } from "./ui-feedback.ts";
import * as Plugin from "@opencode/plugin/tui/plugin";
import { AutoCodeRpc } from "./rpc.ts";
import { AUTOCODE_HELP, parseAutoCodeCommand, type AutoCodeCommand } from "./commands.ts";
import { editSettings } from "./settings-ui.ts";
import { showHelp, showStatus, viewReviewLog } from "./diagnostics-ui.ts";

export default Plugin.define({
  id: "autocode",
  setup(ctx) {
    const rpc = ctx.client.rpc(AutoCodeRpc);
    let disposed = false;
    let controller: AbortController | undefined;
    const open = async (command: AutoCodeCommand | "unknown") => {
      if (disposed || controller) return;
      const current = controller = new AbortController();
      const active = () => !disposed && controller === current;
      try {
        if (command === "config") await editSettings(ctx, rpc, active, current.signal, () => viewReviewLog(ctx, rpc, active, current.signal));
        else if (command === "log") await viewReviewLog(ctx, rpc, active, current.signal);
        else if (command === "status") await showStatus(ctx, rpc, active, current.signal);
        else if (command === "help") await showHelp(ctx, active, current.signal);
        else await ctx.ui.dialog.alert({ title: "AutoCode commands", message: `Unknown AutoCode command.\n\n${AUTOCODE_HELP}` });
      } catch (error) {
        if (active() && !current.signal.aborted && !(error instanceof Error && error.name === "AbortError")) showToast(ctx, { title: "AutoCode command failed", message: "Try the command again. If it keeps failing, restart OpenCode.", variant: "error", duration: 8000 });
      } finally { current.abort(); if (controller === current) controller = undefined; }
    };
    const stop = () => {
      if (controller) { controller.abort(); controller = undefined; ctx.ui.dialog.clear(); }
    };
    ctx.keymap.layer(() => ({ mode: "global", commands: [
      {
        id: "autocode.config", title: "AutoCode config", description: "Configure automatic command approval", group: "AutoCode", palette: true,
        slash: { name: "autocode", arguments: true },
        async run(input) { await open(input === undefined ? "config" : parseAutoCodeCommand(input) ?? "unknown"); },
      },
      { id: "autocode.log", title: "AutoCode review log", description: "View recent reviewer verdicts", group: "AutoCode", palette: true, async run() { await open("log"); } },
      { id: "autocode.status", title: "AutoCode status", description: "Show effective project settings", group: "AutoCode", palette: true, async run() { await open("status"); } },
      { id: "autocode.help", title: "AutoCode help", description: "List AutoCode commands", group: "AutoCode", palette: true, async run() { await open("help"); } },
    ] }));
    const unsubscribes = ([
      ["openSettings", "config"], ["openLog", "log"], ["openStatus", "status"], ["openHelp", "help"],
    ] as const).map(([event, command]) => rpc.events.on(event, async event => {
      if (disposed) return;
      const route = ctx.ui.router.current();
      if (route.type === "session" && route.sessionID === event.data.sessionID) await open(command);
    }));
    const reconnect = ctx.data.on("server.connected", stop);
    return () => {
      disposed = true;
      stop();
      for (const unsubscribe of unsubscribes) unsubscribe();
      reconnect();
    };
  },
});
