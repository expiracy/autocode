# Changelog

## 0.1.0-beta.1 — Staged, awaiting human approval

First planned npm release as `opencode-autocode`, using the `next` distribution tag, with the AutoCode
plugin ID and `/autocode config` command. Tested with OpenCode 2.0.28.

- Review individual pending shell commands with the proposing model and variant,
  or a separately configured reviewer.
- Return allow, ask, or deny; retain manual approval when evidence is incomplete,
  the response is invalid, a provider fails, or the deadline expires.
- Preserve OpenCode permission denies, saved-approval precedence, and hard tool
  policies, including compound commands.
- Configure global settings in the native terminal UI, with connected model and
  variant choices, JSONC preservation, backups, and revision checks.
- Inspect the latest 100 project reviews with `/autocode log`, including reviewer
  verdicts, reasons, model choices, and timings. Refresh or clear the history in
  the native viewer; command and conversation payloads are excluded.
- Show effective project settings with `/autocode status` and command help with
  `/autocode help` or bare `/autocode`. The old `settings` alias is removed.
- Provide bounded, tool-free reviews without truncating command or conversation
  evidence.
- Distribute built JavaScript and type declarations under the MIT licence.
