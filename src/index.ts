import { Plugin } from "@opencode/plugin";
import { realpath } from "node:fs/promises";
import { setupApproval } from "./approval.ts";
import { setupSettings } from "./settings-server.ts";
import { GlobalSettings } from "./settings.ts";
import { ReviewLog } from "./review-log.ts";

export default Plugin.define({
  id: "autocode",
  async setup(ctx) {
    const directory = ctx.location.directory ?? ctx.location.project.canonical;
    const scope = await realpath(directory).catch(() => directory);
    const log = new ReviewLog(ctx.storage, scope);
    await setupApproval(ctx, log);
    await setupSettings(ctx, new GlobalSettings(), log);
  },
});
