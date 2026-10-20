# Installation and troubleshooting

[README](../README.md) · [Configuration](configuration.md)

## Use a local checkout

For local development or to try a specific source revision, build with **Node.js 22.18 or newer** and npm:

```sh
git clone https://github.com/expiracy/autocode.git
cd autocode
npm ci
npm run build
```

Use the [global plugin registration from the README](../README.md#install), but replace `package` with the absolute path to your checkout:

```json
{
  "package": "/absolute/path/autocode",
  "options": {}
}
```

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `/autocode config` or the palette entry is missing | Use OpenCode v2, confirm the global plugin registration loaded, and restart OpenCode including the terminal client. For a local checkout, run `npm ci` and `npm run build` first. |
| Commands run without a reviewer | Check that AutoCode is enabled and that OpenCode resolves the request to `ask`. Existing `allow` rules skip AutoCode. |
| Commands remain blocked | Check permission denies and hard tool policies. AutoCode cannot override them. A reviewer may also deliberately return `deny`. |
| The normal prompt remains | Read its `autocode:` explanation. Check the selected provider connection, model and variant, timeout, context budget, and availability of the full command and user context. |
| The OpenCode free model rejects a review | Some free models reject isolated review requests even when they work as the coding model. Choose a separate connected reviewer in **Approval model**; keep your coding model selected. |
| Saving says multiple registrations exist | Keep one global AutoCode registration, including across `opencode.json` and `opencode.jsonc`. Remove an old local-path registration when switching to the npm package. |
| Saved settings seem ineffective in one project | Check that project's plugin options for an override. Confirm you are editing the config directory used by the running OpenCode instance. |
| The log is empty | Only reviews made by this AutoCode version appear. Existing allow/deny decisions and requests while disabled skip review. Use **Refresh** after a new review and check that you are in the same project. |
| A log entry says `allow`, but the command was blocked | The entry is AutoCode's verdict. OpenCode's hard policies can reject the command afterward. |

If the problem persists, [open an issue](https://github.com/expiracy/autocode/issues) with your OpenCode and AutoCode versions, installation method, sanitized plugin options, and the relevant error. Remove credentials and private conversation content before sharing.

Settings, log, and status failures also show a native error notification in the terminal. Keep the dialog open to review details or retry; a review-provider failure still falls back to manual approval.

## Update or uninstall

The npm example uses the `next` beta channel. For a fixed version, replace the registration's `package` with an exact specifier such as `opencode-autocode@0.1.0-beta.4`. Review the [changelog](../CHANGELOG.md) before upgrading, and restart OpenCode after changing its registration. While using a local checkout, pull the desired revision, run `npm ci` and `npm run build`, then restart OpenCode.

To pause automatic reviews, disable AutoCode in settings. To uninstall, clear any review history you want removed through `/autocode log`, remove its entry from the global `plugins` array and any project registrations, then restart OpenCode. Keep your permission rules and policies as needed for normal OpenCode approvals. Optional settings backups and OpenCode's plugin storage remain after removing a registration.
