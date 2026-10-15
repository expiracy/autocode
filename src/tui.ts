import * as Plugin from "@opencode/plugin/tui/plugin";
import { AutoCodeRpc } from "./rpc.ts";
import { editSettings } from "./settings-ui.ts";

export default Plugin.define({
  id: "autocode",
  setup(ctx) {
    const rpc = ctx.client.rpc(AutoCodeRpc);
    let disposed = false;
    let controller: AbortController | undefined;
    const open = async () => {
      if (disposed || controller) return;
      const current = controller = new AbortController();
      try { await editSettings(ctx, rpc, () => !disposed && controller === current, current.signal); }
      finally { current.abort(); if (controller === current) controller = undefined; }
    };
    const stop = () => {
      if (controller) { controller.abort(); controller = undefined; ctx.ui.dialog.clear(); }
    };
    ctx.keymap.layer(() => ({ mode: "global", commands: [{
      id: "autocode.settings", title: "AutoCode settings", description: "Configure automatic command approval", group: "AutoCode", palette: true,
      slash: { name: "autocode", arguments: true },
      async run(input) {
        const argument = (input ?? "").trim().replace(/^\/?autocode(?:\s+|$)/, "").trim();
        if (argument && argument !== "settings" && argument !== "config") {
          await ctx.ui.dialog.alert({ title: "AutoCode", message: "Use /autocode settings to configure automatic command approval." });
          return;
        }
        await open();
      },
    }] }));
    const unsubscribe = rpc.events.on("openSettings", async event => {
      if (disposed) return;
      const route = ctx.ui.router.current();
      if (route.type === "session" && route.sessionID === event.data.sessionID) await open();
    });
    const reconnect = ctx.data.on("server.connected", stop);
    return () => {
      disposed = true;
      stop();
      unsubscribe();
      reconnect();
    };
  },
});
