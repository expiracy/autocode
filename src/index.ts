import { Plugin } from "@opencode/plugin";
import { setupApproval } from "./approval.ts";
import { setupSettings } from "./settings-server.ts";
import { GlobalSettings } from "./settings.ts";

export default Plugin.define({
  id: "autocode",
  async setup(ctx) {
    await setupApproval(ctx);
    await setupSettings(ctx, new GlobalSettings());
  },
});
