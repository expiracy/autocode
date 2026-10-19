# AutoCode behavior

- [x] Review a pending shell command with the originating assistant's model and variant.
- [x] Use an explicitly configured approval model, including IDs containing slashes.
- [x] Leave existing allows, denies, and unrelated permission actions unchanged.
- [x] Apply explicit allow, ask, and deny decisions to only the current request.
- [x] Keep malformed, incomplete, or ambiguous responses at ask.
- [x] Keep API failures, missing context/model, and timeouts at ask.
- [x] Provide user intent and exact command details without executing reviewer tools.
- [x] Bound context size without silently truncating the proposed action.
- [x] Validate options and support disabling the plugin.
- [x] Preserve separation between concurrent sessions and the proposing model versus a later selection.
- [x] Load the packed plugin in OpenCode 2.0.28 and auto-approve a real shell call.
- [x] Offer enabled, model, variant, timeout, and context-budget controls in the native settings dialog.
- [x] Open settings from `/autocode config` without calling the coding model, including while disabled.
- [x] List connected models and supported reasoning variants through native RPC.
- [x] Save choices in the global native plugin options while preserving unrelated configuration.
- [x] Apply disable and inherited-model settings to subsequent real native permission evaluations.
- [x] Preserve project reviewer overrides when global approval is disabled.
- [x] Keep the settings command visible while the native command palette owns modal input.
- [x] Search connected models by displayed name, provider, or raw model ID.

Plugin validation covers unit tests, type checking, and build. The installed
OpenCode 2.0.28 terminal client was also checked directly: the command palette
and `/autocode config` open the editor, raw model-ID searches return connected
models, and the reasoning-variant picker renders the model's available variants.
The terminal checks closed without saving changes.

## Commands and review history

- [x] Use `/autocode config` as the settings command, rejecting the old `settings` alias.
- [x] Open `/autocode log`, `/autocode status`, and `/autocode help`; bare `/autocode` opens help.
- [x] Keep every command available while disabled, without generating model requests.
- [x] Retain the newest 100 reviews in durable plugin storage, isolated by canonical project location.
- [x] Preserve history across reloads, concurrent writes, and directory aliases.
- [x] Record verdict, reason, selected model, session, timestamp, and duration without raw command, conversation, or provider-error fields.
- [x] Keep logging failures or stalled writes from delaying or changing permissions.
- [x] Search, refresh, inspect details, and clear only the current project's history after confirmation.
- [x] Open the log from config and return to an unsaved draft without saving it.
- [x] Show effective project status, including model overrides and disabled state.
- [x] Keep configured denies out of AutoCode history and label later policy-blocked approvals as reviewer verdicts.
- [x] Verify actual native config, log list/details, and bare-command help without user configuration changes.

Both native installation modes passed on OpenCode 2.0.28. The directory alias
regression was also verified with macOS `/var/...` API locations and the native
TUI's `/private/var/...` location for the same directory. Reasons may quote supplied
context despite the metadata-only storage shape; the UI and README explain this.

## npm release preparation

- [x] Recognize global `opencode-autocode` registrations by name, pinned prerelease, and distribution tag.
- [x] Preserve the package specifier, unrelated options, and deny rules when saving settings.
- [x] Refuse unrelated registry package names while retaining local path and symlink support.
- [x] Install the renamed tarball from an empty npm cache with normal dependency and peer resolution.
- [x] Run the full native suite from that installation without consumer build scripts.
- [x] Ship MIT licensing, release metadata, examples, and user documentation in the package.
- [ ] Verify installation directly from the public npm package after publication.

The candidate version is `opencode-autocode@0.1.0-beta.1`, intended for `next`.
It is staged at npm and still awaits human approval. The public `0.0.0-stage`
placeholder is not the plugin, and public package installation is not verified.
The registry installation check downloads dependencies but installs the plugin
from its local packed tarball; it cannot test public package-name resolution yet.
The GitHub workflows test one artifact and rehearse delivery by default. Only
explicit staging uses npm OIDC; final publication remains a human action.
`npm run smoke:published` separately checks public registry installation after
publication; its checkbox above is marked only after an actual successful run.

## Controlled CI and delivery

- [x] Reject an invalid workflow with a useful lint diagnostic and accept a valid fixture.
- [x] Lint the repository workflows with official, checksummed actionlint 1.7.12.
- [x] Build one tarball and record source commit, version, MIT licence, channel, SHA-256, and SHA-512 integrity.
- [x] Reject changed artifacts, mismatched source/version, and invalid release metadata before installation or delivery.
- [x] Install the recorded artifact on Node.js 22.18 and 24 with fresh caches and lifecycle scripts disabled.
- [x] Run the native suite against that exact artifact on Linux and macOS with OpenCode 2.0.28.
- [x] Fail the aggregate **CI required** check if any dependency fails, is cancelled, or is skipped.
- [x] Require the aggregate GitHub Actions check in actual `main` branch protection.
- [x] Complete a manual rehearsal without npm delivery or OIDC credentials.
- [x] Restrict npm staging to an explicit request from `main` through the `npm-staging` environment.
- [ ] Verify npm's external trust binding allows stage-only OIDC with no direct publish or dist-tag privilege.
- [ ] Obtain human npm review and 2FA approval before a version becomes public.

These delivery scenarios are separate from the plugin's established behavior.
Mark them complete only after observing the relevant local check, hosted run, or
external setting; workflow source alone does not prove a repository or npm gate
is configured. Package artifacts retain their immutable GitHub ID for handoffs,
and diagnostics must exclude profiles, credentials, and conversation payloads.

[Hosted CI on 19 October 2026](https://github.com/expiracy/autocode/actions/runs/39216538980)
passed 158 unit tests on each Node version, both fresh-cache installation jobs,
both native host integrations, workflow lint, and **CI required**. The downloaded
tarball, installation results, and Linux/macOS native results all record SHA-256
`e858cf8db7ee4ffa2edd3a2ddb52c71f2a067329e8eddc55f02e292e4555f60d`
for source commit `91dafae05bbd1a4f496b5b7b12201f1ec3fae696`. Retained results
contain bounded test metadata and infrastructure logs; inspection found no
credentials or conversation payloads. Local fixtures also verified the actual
aggregate expression rejects failure, cancellation, and skipping. GitHub's API
confirmed the required check is bound to the Actions app, enforced for admins,
and requires an up-to-date PR; the staging environment allows exactly branch
`main`, with no tag rules or secrets. npm trust and human publication remain
separate unverified steps above.

[Manual Release rehearsal on 19 October 2026](https://github.com/expiracy/autocode/actions/runs/39217634165)
passed the reusable CI suite and rehearsal verification at main commit
`6ad5500ed708f70d953fee6a3f92b89808b03445`. The tarball, both Node installation
results, and both OpenCode host results share SHA-256
`dcf6c32abbb04f7de8513a3fc5a79a75c40f84d69df7ec79004cb1e9cde3951d`.
The tarball's SHA-512 integrity and both native results also match the manifest.
The npm staging job was skipped, so this run requested no OIDC delivery credentials and uploaded nothing
to npm. Retained diagnostics inspection found no credentials or conversation
payloads.

## Hard rejection precedence

- [x] Preserve an existing deny and its original reason without reading session context or calling a model.
- [x] Reject a configured permission deny without calling the reviewer or offering an approval prompt.
- [x] Reject a compound command when one of its resources is denied.
- [x] Keep a configured deny final even when a saved “Allow always” approval matches.
- [x] Enforce a hard tool policy even when the automatic reviewer returns allow.
- [x] Stop a real configured-denied shell tool before its harmless output file is created, without a review or prompt.
- [x] Stop a real policy-denied shell tool after an automatic allow, without creating its output file or an approval prompt.

These native checks passed on OpenCode 2.0.28 with an isolated temporary
configuration and a local reviewer that always returns allow. Configured permission
denies must bypass review; hard tool policies may reject after a review call.
OpenCode's normal last-matching-rule semantics still determine the resolved
permission effect. AutoCode does not maintain a separate deny-list matcher.

## Real provider verification

`node test/live-provider.mjs --model openai/gpt-6.1-sol --variant low --reviewer openai/gpt-6-luna`
passed against the installed OpenCode 2.0.28 server using its real OpenAI connection.
The disabled control asked, authorized `printf` was allowed, unknown script and
unrelated deletion asked, prohibited deletion and approval injection were denied,
and the separate reviewer allowed the authorized command. A real coding-model
turn automatically approved and completed `printf autocode-live-check`.
Destructive cases were permission-only fixtures. Temporary sessions and projects
were removed; installed options were unchanged. Per-review decisions took about
2.5–4.4 seconds. The dated report is saved under `.live-validation/`.

## Free-provider compatibility regression

- [x] Reproduce a free DeepSeek provider rejecting an isolated review.
- [x] Distinguish that provider rejection from a timeout in the approval prompt.
- [x] Use isolated, history-preserving session generation when the reviewer matches the current coding model.
- [x] Preserve the exact selected model and variant for separate or changed models.
- [x] Isolate concurrent review requests and clean their frames up on success, failure, and cancellation.
- [x] Verify a DeepSeek coding session with a configured GPT-6 Luna reviewer.

The free DeepSeek provider tested here rejects isolated inference requests. A
separate `openai/gpt-6-luna` reviewer with variant `low` allowed the coding model
to remain DeepSeek. The exact `pwd; ls -la` request was reviewed and completed.
Existing queued requests were resolved once only after review allowed them.

The packed integration test in
`test/smoke.mjs` passes against OpenCode 2.0.28 using an isolated global
configuration and a local fake provider. It checks inherited and overridden
reviewer models, an actual `printf` tool call, the settings command, persisted
settings, and updated runtime approval behavior. Run `npm run check` and
`npm run smoke` to verify the current implementation.
