# Changelog

## 0.1.0-beta.1 — Unreleased

First planned npm release, published as `opencode-autocode` with the AutoCode
plugin ID and `/autocode settings` command. Tested with OpenCode 2.0.28.

- Review individual pending shell commands with the proposing model and variant,
  or a separately configured reviewer.
- Return allow, ask, or deny; retain manual approval when evidence is incomplete,
  the response is invalid, a provider fails, or the deadline expires.
- Preserve OpenCode permission denies, saved-approval precedence, and hard tool
  policies, including compound commands.
- Configure global settings in the native terminal UI, with connected model and
  variant choices, JSONC preservation, backups, and revision checks.
- Provide bounded, tool-free reviews without truncating command or conversation
  evidence.
- Distribute built JavaScript and type declarations under the MIT licence.

This version has not been published to npm. The planned distribution tag is
`next`; local checkout installation remains available before publication.
