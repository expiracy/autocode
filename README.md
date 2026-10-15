# AutoCode

An OpenCode v2 plugin that uses a model to review shell commands awaiting approval. By default, the reviewer uses the model and variant of the assistant that proposed the command in the same session. If model metadata is missing, it uses the session model, then OpenCode's default model. You can select a separate reviewer model without changing the coding model.

The reviewer can allow the pending command, leave it for your normal approval prompt, or deny it. Existing `allow` decisions bypass review, and configured `deny` rules stay blocked. Reviews apply to individual requests; the plugin never saves an “Allow always” rule. This follows OpenCode's [v2 permission hook](https://opencode.ai/v2/docs/build/plugins/#permissions) and [permission rules](https://opencode.ai/v2/docs/permissions/).

AutoCode only reviews shell permissions whose current effect is `ask`. OpenCode rejects commands matching its resolved permission deny rules before calling the reviewer, including compound commands with a denied resource and commands with a saved “Allow always” approval. OpenCode's hard [tool policies](https://opencode.ai/v2/docs/policies/) also remain enforced: a policy can reject a command even after the reviewer returns `allow`. Such policy checks can happen after a model call. AutoCode settings never edit your permission rules or policies.

This project targets OpenCode **2.0.28** and its v2 plugin API. Building and testing requires **Node.js 22.18 or newer** and npm. Build the local checkout before loading it:

```sh
cd /absolute/path/autocode
npm ci
npm run build
```

Add AutoCode to your global `~/.config/opencode/opencode.jsonc`, replacing the package path with the absolute path to your checkout. Merge it with your existing configuration. OpenCode also supports `opencode.json` and its configured config directory:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/autocode",
      "options": {}
    }
  ],
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" }
  ]
}
```

Start or restart OpenCode. Open **AutoCode settings** from the command palette, or enter `/autocode settings` (also `/autocode`) in the terminal UI. The settings dialog lets you enable or disable automatic approval, inherit the coding model or select a connected model and reasoning variant, and change the review timeout and context budget. Choose **Save settings** to persist your changes; closing an edited draft offers to discard it or keep editing.

Settings are global and use AutoCode's existing native plugin `options`. They remain editable as JSON, including through OpenChamber's **Settings → Plugins** options editor. Saving preserves the rest of your OpenCode configuration and creates a backup under `.autocode/settings-backups/` beside it. OpenCode reloads saved options for subsequent reviews. Project-specific plugin options still override global defaults. Install one global AutoCode registration to use the settings dialog. After updating the plugin, restart the terminal client to load its settings companion.

Omitting `options.model` inherits the proposing model; `"model": "inherit"` has the same effect. The [complete example](examples/opencode.jsonc) includes the default timeout and context budget. OpenCode v2 loads package directories through the [`plugins` array](https://opencode.ai/v2/docs/build/plugins/#options). Its configuration uses `permissions` and the `shell` action. Rules use the last matching entry, so place any specific `allow` or `deny` exceptions after the broad `ask` rule.

To select a separate reviewer, replace the plugin's `options` with:

```json
{
  "model": "provider/model"
}
```

Use a provider and model already available in OpenCode. The first slash separates the provider ID from the model ID, so `"openrouter/vendor/model"` selects provider `openrouter` and model `vendor/model`. To choose a reasoning variant, use the object form:

```json
{
  "model": {
    "providerID": "provider",
    "id": "model",
    "variant": "high"
  },
  "timeoutMs": 30000,
  "maxContextChars": 64000
}
```

`variant` is optional and must name a variant supported by that model. The plugin uses OpenCode's existing provider connections. Each eligible pending request makes at most one tool-free model call, with the usual provider latency, usage limits, and costs. The review includes the command, working directory, and session conversation. Selecting another provider sends that review context to the selected provider.

| Option | Default | Accepted values |
| --- | --- | --- |
| `enabled` | `true` | Boolean. Set `false` to leave approvals to OpenCode. |
| `model` | Inherit | Omit, use `"inherit"`, use `"provider/model"`, or use `{ "providerID": "…", "id": "…", "variant": "…" }` with optional `variant`. |
| `timeoutMs` | `30000` | Integer from `1` to `300000`; deadline for the complete review. |
| `maxContextChars` | `64000` | Integer from `1000` to `1000000`; maximum serialized review data size in JSON characters. |

Unknown options, misspelled model fields, empty identifiers, and invalid values fail plugin setup with a configuration error.

Some OpenCode free models reject isolated approval reviews even when they work as
the coding model. AutoCode reports that provider rejection in the approval prompt.
Choose a separate connected reviewer under **AutoCode settings → Approval model**;
your coding model can stay selected. Inherited reviews use OpenCode's transient
session generation with an isolated review policy, evidence, and no tools. A
separate reviewer uses its explicitly selected provider and model.

The normal user prompt remains when the reviewer is uncertain, its response is invalid, user messages or the full originating command are unavailable, the selected model is unavailable, an API call fails, or the deadline expires. Parsed permission resources alone can omit parts of a compound command. The full review data must fit `maxContextChars`: the plugin never truncates the command or conversation to obtain an approval. If the budget is exceeded, compact the session or raise the budget. Compaction can also remove evidence of authorization, in which case the reviewer may still ask.

Model judgments are probabilistic and cannot guarantee safe approval. Keep any firm restrictions in OpenCode's configured permission rules.

Run the project checks after making changes:

```sh
npm run typecheck
npm test
npm run build
# Or run all three:
npm run check
```

For an integration check with an installed OpenCode v2 binary:

```sh
npm run smoke
```

The smoke test packs and installs AutoCode in a temporary global configuration, starts an isolated OpenCode server, and checks inherited and separate reviewer models using a local fake provider. It also checks hard rejection precedence, the settings command, connected model choices, and persistence of settings. Its reviewer always returns `allow`, so the rejection checks verify OpenCode's enforcement independently of model judgment. It does not send model traffic to an external provider or change your installed configuration. It uses `~/.opencode/bin/opencode` when available, otherwise `opencode` on `PATH`; set `OPENCODE_BIN` to select another binary:

```sh
OPENCODE_BIN=/absolute/path/to/opencode npm run smoke
```

To validate a real connected provider, keep your local OpenCode server running and
explicitly select the coding model and, optionally, a separate reviewer:

```sh
npm run test:live -- --model openai/gpt-6.1-sol --variant low --reviewer openai/gpt-6-luna
```

This opt-in check makes real model calls using your existing OpenCode connection.
It uses temporary test conversations and project settings, executes only a harmless
`printf`, and evaluates the destructive examples without executing them. It checks
authorized commands, unknown scripts, unrelated and prohibited deletion, prompt
injection, and a separate reviewer. Results are written under `.live-validation/`.
It is separate from the offline unit and smoke tests.
