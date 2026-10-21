# Changelog

## 0.1.0 — Unreleased

- Prepare the first stable release of AutoCode under the MIT licence, with model-based command review, native configuration, durable review logs, and OpenCode permission and hard-policy enforcement.
- Use the `latest` npm channel and version-pinned stable installation examples.
- Include controlled GitHub Actions publication, immutable source tags, verified package assets, explicit channel selection, and the GitHub asset upload fix from the unreleased candidates below.

## 0.1.0-beta.4 — Unreleased

- Correct GitHub release-asset HTTP framing by sending the exact verified byte length. A real local HTTP test exercises the installed GitHub CLI with binary and Unicode bytes.
- Prepare a fresh tagged candidate after the previous Actions run created immutable `v0.1.0-beta.3` and a partial draft before its upload failed. That tag remains unchanged; the previous candidate has not been published to npm.

## 0.1.0-beta.3 — Unreleased

- Add a manual **Publish npm package** workflow: rehearsal by default, direct OIDC publication after required human approval in the protected `npm-production` GitHub environment.
- Require the immutable version tag to identify the exact source commit, publish the CI-tested tarball without repacking or lifecycle scripts, and verify public registry integrity with provenance enabled.
- Retain the separate npm staging path. `0.1.0-beta.2` was published from its OIDC stage on 20 October 2026; this fresh version keeps that published version immutable.

## 0.1.0-beta.2 — 2026-10-20

Published to npm under `next` after human approval of the CI-tested OIDC stage.
The public archive matches the staged bytes; fresh registry installation and all
20 native checks passed on macOS with OpenCode 2.0.28. See the
[release verification record](RELEASING.md#published-beta2-verification).

- Show native error notifications for settings, log, status, and unexpected UI failures, while keeping drafts and retry controls available. Notification failures do not repeat saved changes.
- Add a manual GitHub release rehearsal and draft action, with immutable version tags and the exact CI-tested package, manifest, and checksums. Human publication remains separate.
- Shorten the README, preserve detailed configuration and troubleshooting guides, and add Ko-fi support links.

- Present the native settings and review screenshots in the npm README, with
  versioned image links and demonstration captions.
- Correct installation and release status now that the first beta is public.
- Add the AutoCode logo and show settings and review popups in the full application viewport.

## 0.1.0-beta.1 — 2026-10-18

First npm release as `opencode-autocode`, using the `next` distribution tag, with the AutoCode
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
