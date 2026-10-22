# Releasing AutoCode

AutoCode ships as `opencode-autocode` under the MIT licence. The package requires
Node.js 22.18 or newer and the OpenCode v2 plugin API. CI checks Node.js 22.18 and
24 and runs native integrations with OpenCode 2.0.28 on Linux and macOS. Windows
host support is not part of this release's verified scope.

`0.1.0-beta.2` is public on npm under `next`, following human approval of its
OIDC stage on 20 October 2026. Its registry archive and native installation are
verified below. The earlier `0.1.0-beta.1` first shipped on 18 October and replaced
the `0.0.0-stage` placeholder as `latest` on 20 October. Check the live registry
tags when selecting the default install version.

Stable `0.1.0` was published to `latest` through GitHub Actions OIDC on
21 October 2026. Its `v0.1.0` tag remains at the exact tested source commit.
Earlier unpublished beta candidates and their existing tags are retained as
history. A passing rehearsal or uploaded stage alone does not establish
publication.

## Stable 0.1.0 verification

| Item | Evidence |
| --- | --- |
| Public package | [`opencode-autocode@0.1.0`](https://www.npmjs.com/package/opencode-autocode/v/0.1.0), recorded by npm at 2026-10-21 07:22:30 UTC; `latest`, MIT. |
| Source | [`90b0627c8ed6b6e20c77e882f2a7e6ab82c689e3`](https://github.com/expiracy/autocode/commit/90b0627c8ed6b6e20c77e882f2a7e6ab82c689e3), immutable tag `v0.1.0`. |
| Tested draft | [Workflow 39559092055](https://github.com/expiracy/autocode/actions/runs/39559092055) passed full CI and created a normal GitHub draft with the tarball, original manifest, and checksums. |
| Publication | [Workflow 39559929969](https://github.com/expiracy/autocode/actions/runs/39559929969), after the maintainer approved `npm-production`. The first attempt published successfully but its immediate registry verification saw stale data and failed; public registry metadata and bytes were subsequently verified. |
| Artifact | Public tarball, production CI artifact, and GitHub draft match byte for byte; SHA-256 `7f575e4c18525fd2351b11cb692d25e4c93ae6afcb4b3e39598fcfa2a3dd601b`. |
| Product page | The default npm README is the packaged stable README, including its top logo, screenshots, and Ko-fi link; public image bytes match the packaged assets. |
| Provenance | Public npm SLSA payload identifies the exact source commit and `publish.yml` on `main`; payload inspection is separate from independent Sigstore cryptographic verification. |

The published archive is immutable. The visibility handling change below applies
to future release workflow executions; do not rebuild or replace `0.1.0`.

## Published beta.2 verification

| Item | Verified result on 20 October 2026 |
| --- | --- |
| Public package | [`opencode-autocode@0.1.0-beta.2`](https://www.npmjs.com/package/opencode-autocode/v/0.1.0-beta.2), recorded by npm at 20:49:23 UTC; MIT licence and `next` channel. |
| Source | [`7a9f523d83258fe82b3d63f35e1dfa55e60586bf`](https://github.com/expiracy/autocode/commit/7a9f523d83258fe82b3d63f35e1dfa55e60586bf), tagged `v0.1.0-beta.2`. |
| Tested stage | [CI and OIDC staging run](https://github.com/expiracy/autocode/actions/runs/39472166246); stage `1039ff01-a667-462c-be10-3813645a0e38` was approved by the maintainer in npm. |
| Archive | The 59-file public tarball is byte-identical to the tested stage; SHA-256 `18c9f1f39cf3684d3780edc47236db0cb975de9c1b3d67105b4caa620e60818b`. |
| Installed check | Fresh public-registry installation and all 20 native checks passed on macOS arm64, Node.js 26.3.0, and OpenCode 2.0.28. |

The post-publication native check used isolated profiles and a local scripted
provider for all 22 model requests, with no external model calls. It exercised
inherited and separate reviewer models, a real harmless shell call, settings,
history, and hard-deny precedence. These results verify this published package;
they do not certify future candidates or add host/platform support. Product
logos, screenshots, and the Ko-fi link were also verified in the public archive.

## Delivery contract

Pull requests, merge queues, and pushes to `main` always produce the required
**CI required** check. Local development and feature-branch pushes do not start
Actions. The planner reads the complete Git diff without workflow-level path
filters, so documentation updates cannot leave the merge check pending.

| Change or request | Validation |
| --- | --- |
| Known Markdown documentation, product images, or funding link | Lightweight planning and merge gate; no runtime jobs or uploads. |
| Ordinary source, tests, or unknown file paths | Workflow lint, typechecking, and unit tests on the supported Node.js 22.18 minimum. |
| Dependencies, runtime/compiler configuration, public entrypoints, native test harness, workflows, or delivery helpers | Full Node.js 22.18/24, package installation, and native OpenCode Linux/macOS checks. |
| Manual **CI** run with `full=true` | Full compatibility validation. Set `full=false` for a deliberate quick check. |
| Any release, GitHub draft, or npm publication workflow | Full validation, explicitly required by the reusable workflow caller. |

Draft pull requests use the same policy as ready pull requests. The aggregate
requires every job selected by the plan to succeed and every unselected job to
be intentionally skipped. Missing or inconsistent outputs, failure, cancellation,
or an unexpected skip fails the gate. Require **CI required** from the GitHub
Actions app in `main` protection, require branches to be up to date, and enforce
protection for administrators. See live protection settings before claiming that
enforcement is active.

Full validation waits for fast checks, builds JavaScript, and packs **one npm
tarball**. Its `manifest.json` binds source commit, repository, package name and
version, MIT licence, default channel, filename, SHA-256, SHA-512 integrity, and
build Node/npm versions. Prereleases default to `next`; stable versions default
to `latest`. An explicit publication selection can use `latest` for a new beta;
existing versions are never retagged by delivery.

The same uploaded `package.tgz` and original manifest pass by immutable GitHub
artifact ID to every consumer. Fresh-cache installation on both Node versions
and native OpenCode checks on Linux and macOS verify those bytes without
rebuilding or repacking. Runtime dependencies and peers resolve normally from
npm with consumer lifecycle scripts disabled. Native checks use temporary
profiles and a local fake provider, with no paid model calls or maintainer
provider connections.

### Cost controls

- Use standard GitHub-hosted runners, which are free for public repositories;
  do not select billable larger runners. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
- Keep an Actions budget of **$0** with **Stop usage when budget limit is reached**
  enabled for a hard spending backstop. Billing budgets are configured outside
  workflow YAML; alerts alone do not stop spending.
- Development validation retains an archive for **one day**. Release callers
  explicitly retain their reviewed archive for **30 days** to allow human approval.
- Passing ordinary checks upload no diagnostic artifacts. Failures retain
  diagnostics for **three days**; full release diagnostics remain for **14 days**.
  Sanitized host reports contain no profiles, credentials, or conversation payloads.
- SHA-pinned Actions, read-only ordinary jobs, non-persisted checkout credentials,
  timeouts, cancellation of superseded PR runs, and disabled package-manager
  caches remain in place. Dependabot groups weekly updates; dependency changes
  still receive full compatibility checks.

Artifact storage is a separate shared allowance. Download release evidence
before expiry; short retention limits future storage use without deleting
existing review evidence.

## One-time delivery setup

The workflow is ready to rehearse without npm credentials. Staging additionally
requires both external gates below; workflow source alone does not configure
them.

1. In GitHub, create the `npm-staging` environment. Allow deployments only from
   branch `main`, without a matching tag rule. The staging job names this
   environment, and npm must match the same name. A required GitHub reviewer can
   add an earlier staging gate; final npm approval remains separate.
2. As a package maintainer, configure an npm trusted publisher for package
   `opencode-autocode`, repository `expiracy/autocode`, workflow filename
   `release.yml`, and environment `npm-staging`. Allow **staging only**. Leave
   direct publishing and dist-tag modification disabled. Using an interactive
   maintainer session with 2FA, the equivalent CLI command is:

   ```sh
   npm trust github opencode-autocode \
     --repo=expiracy/autocode \
     --file=release.yml \
     --environment=npm-staging \
     --allow-stage-publish
   ```

   npm trust administration requires interactive maintainer authentication and
   account 2FA; a stored automation token is not a substitute. Check the actual
   trust entry with `npm trust list opencode-autocode` or npm's package settings.
   npm requires a new trust entry to be validated within two days. If it expires,
   recreate it when an explicitly requested staging run is ready.

The `release.yml` / `npm-staging` binding was configured, inspected as stage-only,
and used successfully for beta.2 on 20 October 2026. This does not configure the
separate production binding or change npm's legacy-token access policy.

Use GitHub-hosted runners. The staging job pins npm 12.2.0, satisfying staged
publishing's npm 11.15/Node 22.14 minimum. It has `contents: read` and
`id-token: write`; other jobs in the staging workflow do not get an OIDC token. The delivery helper rejects
missing OIDC identity and token authentication instead of falling back to a
stored npm key. Do not add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, npm credentials, or a
direct-publish fallback to staging. Direct publication uses the separate,
explicitly requested and human-gated `publish.yml` path below.

Check npm's package publishing access settings too. Requiring 2FA and disallowing
traditional publish tokens keeps all automated delivery on the approved OIDC
path. Review existing trusted publishers so direct publishing is allowed only by the separate `publish.yml` /
`npm-production` binding, never by the staging binding. Changing these settings is a maintainer action, not
something a rehearsal verifies.

## Prepare the candidate

1. Update `package.json` and `package-lock.json` together. Use a prerelease version
   for beta delivery, update `CHANGELOG.md`, and keep README/example version pins
   aligned. Set `publishConfig.tag` to `next` for prereleases or `latest` for stable
   versions; artifact verification rejects a mismatched channel. npm versions
   cannot be reused after publication.
2. Confirm licence, exported server and TUI entrypoints, documentation, runtime
   versions, and OpenCode support. Do not include local state, credentials,
   validation transcripts, or caches in the package.
3. Merge the candidate through a pull request after **CI required** passes. Keep
   the source commit you intend to release available on protected `main`.
4. For a local check before opening the PR:

   ```sh
   npm ci --ignore-scripts
   npm run check
   npm run lint:workflows
   npm run smoke:registry
   ```

   Local smoke checks are useful preparation; they do not replace the exact
   artifact checks in the release workflow.

## Rehearse, then request staging

Open GitHub Actions → **Release** → **Run workflow**, choose `main`, and leave
`delivery` at its default `rehearsal`. The equivalent CLI request is:

```sh
gh workflow run release.yml --ref main -f delivery=rehearsal
```

The workflow runs the full CI pipeline at its dispatch commit. Rehearsal downloads
and verifies the tested artifact and reports its manifest, without requesting
OIDC credentials or sending anything to npm. Inspect the actual run, aggregate
result, manifest, package contents, and diagnostics. A successful run does not
prove npm trust is configured.

Only when a maintainer explicitly wants to submit that candidate for review,
select `delivery: stage` from `main`:

```sh
gh workflow run release.yml --ref main -f delivery=stage
```

This run again creates one package and tests that same artifact. After every CI
check passes, the `npm-staging` job verifies the downloaded artifact's source,
version, licence, release channel, and checksums, then submits the existing
archive using npm OIDC staged delivery. It does not run project install/build
scripts, rebuild the archive, or publish it. Retain the workflow URL, source
commit, version, checksum manifest, and npm stage identifier as the review record.
A failed OIDC exchange or stage submission fails delivery; fix the configuration
instead of substituting a token.

## Prepare a GitHub draft

The separate **Prepare GitHub release** workflow (`github-release.yml`) defaults
to a rehearsal. Open GitHub Actions → **Prepare GitHub release** → **Run
workflow**, select `main`, leave `delivery` at `rehearsal`, and run it. The CLI
equivalent is:

```sh
gh workflow run github-release.yml --ref main -f delivery=rehearsal
```

This invocation runs CI once, downloads the exact tested artifact by its
immutable ID, and verifies `package.tgz` and `manifest.json` against the source
commit and checked package version. It generates `RELEASE_NOTES.md` and
`SHA256SUMS` without calling GitHub's release API. Inspect those files and the
sanitized `result.json` in the diagnostic artifact retained for 14 days. The
original package and manifest remain in the CI artifact for 30 days.

When a maintainer explicitly requests a draft, use the same workflow screen on
`main` and change `delivery` to `draft`, or run:

```sh
gh workflow run github-release.yml --ref main -f delivery=draft
```

Draft delivery requires protected `main` in `expiracy/autocode` and successful CI
in that invocation. Only the draft job has repository write permission. It
creates the candidate's `v<version>` source tag and a draft GitHub release with
the verified tarball, original manifest, and `SHA256SUMS`. An existing tag must
already identify the exact commit. A matching draft can receive missing assets;
conflicting assets or an already published release fail without replacement.

Review the draft's notes, source commit, asset checksums, and CI evidence before
publishing it manually. GitHub draft delivery does not stage or publish to npm.
Npm delivery and human 2FA approval use the separate steps above and below.

## Publish from GitHub Actions

**Publish npm package** (`publish.yml`) publishes directly after a human approves
its `npm-production` job in GitHub. It defaults to rehearsal and reuses the full
CI pipeline's single tested artifact. This path does not approve or reject npm
stages; staged versions share npm's version namespace and need their existing
npm approval path. Use a fresh version when changing delivery paths.

### Configure the production gate once

- Create GitHub environment **npm-production** with required reviewer
  **expiracy**, administrator bypass disabled, and a branch rule for **main**
  only (no tag rule). Self-review must remain available for this solo maintainer
  to approve a run they dispatched. The approval is a human action in GitHub.
- Configure a separate npm trusted publisher for `expiracy/autocode`, workflow
  **publish.yml**, environment **npm-production**, with direct publish enabled.
  Keep the existing `release.yml` binding stage-only. No npm token or environment
  secret is required; do not grant standalone dist-tag management.

```sh
npm trust github opencode-autocode \
  --repository=expiracy/autocode --file=publish.yml \
  --environment=npm-production --allow-publish
```

The production npm binding was configured on 21 October 2026 and used for
`0.1.0`: connection `10a7e26c-ddd8-4c78-93cc-c8d34cec06d0` for `publish.yml` /
`npm-production`. npm returned direct publication plus its automatically allowed
staging permission; no standalone dist-tag permission was requested. Recheck the
live binding before future releases. A newly created connection requires its
first successful publication within two days.

Review npm trust and GitHub environment settings after setup. The environment
name in YAML alone does not establish human protection. On 20 October 2026 the
GitHub production gate was configured with these reviewer, bypass, and main-only
rules; a future maintainer must recheck the live settings.

### Run the release

1. Merge the exact unused version and release notes through passing required CI.
2. Run **Prepare GitHub release** with `delivery=draft` at that source revision.
   It creates immutable `v<version>` and a reviewable draft package. Publication
   fails unless this tag resolves to the exact checked-out source commit.
3. Choose `channel=package` to follow the packaged default, or **`channel=latest`**
   to make this new release the default install, including a beta. A standalone
   `delivery=rehearsal` run is optional when you only want a preview.
4. Run **Publish npm package** with `delivery=publish` and that channel. It already
   runs full CI and rehearses the exact artifact before GitHub presents **Review
   deployments** for `npm-production`; a separate rehearsal is not a prerequisite.
5. Review the concrete artifact, then approve that deployment in GitHub. The job
   obtains an environment-bound OIDC identity and publishes the existing archive
   with provenance and lifecycle scripts disabled. It never rebuilds or repacks.

```sh
# Optional standalone preview:
gh workflow run publish.yml --ref main -f delivery=rehearsal -f channel=latest
# Full validation and artifact review are included before the approval gate:
gh workflow run publish.yml --ref main -f delivery=publish -f channel=latest
```

Only the production job has OIDC permission. Its helper rejects an unexpected
repository, branch, unprotected source, workflow, environment, or legacy npm
credentials. A known public version must have identical integrity and still
resolve through the intended channel for a rerun to count as successful; it does
not overwrite versions or move tags to make a rerun pass. Registry errors fail
closed. A public integrity mismatch requires investigation and a new version.
After a new publish, verification reads the package's canonical public index so
its version and channel come from the same response, rather than independently
cached version/tag URLs. Only missing-version or stale-channel visibility is
retried: up to six reads with 5, 15, 40, 80, and 160 second waits, totaling at most
five minutes of waiting. The production job has a 20-minute timeout to retain
headroom for the bounded npm command, registry reads, and diagnostics. The npm
version probe is limited to 30 seconds, and the publish command runs once. Identity, licence or
integrity conflicts, malformed responses, authentication failures and transport
errors fail immediately. Existing-version reruns still fail on channel mismatch
without retagging anything.

The publish request does not approve its own environment deployment. A maintainer
must perform the final GitHub approval; do not bypass the gate with an API call.
After publication, run the registry verification below and inspect npm provenance.
`channel=latest` publishes the exact tested archive directly with that tag; it
does not rewrite its packaged `publishConfig.tag`, version, or manifest. The
review summary and receipt record both channels. This makes default installs
receive the selected beta and makes it the default version shown on npm. It does
not also advance `next`. Use `channel=package` for the normal version-based defaults.
An existing public version on another channel is refused rather than promoted;
that requires a separate maintainer action. No standalone npm dist-tag permission
is needed for a new publication.

## Human publication and verification

For the staged path, a package maintainer must review the stage in npm's **Staged Packages** tab,
compare it with the tested workflow artifact, and approve it with 2FA. Verify
name, version, source commit, integrity, package contents, release notes, and the
intended `next` or `latest` channel before approval. npm OIDC cannot perform this
approval. The separate direct-publication workflow publishes a fresh version
after GitHub approval instead of attempting stage approval.

After either publication path completes:

1. Verify registry metadata and integrity for that exact version and inspect
   `npm dist-tag ls opencode-autocode`. Confirm the selected publication channel
   resolves to this exact version; betas use `next` by default or `latest` when
   explicitly selected.
2. Run `npm run smoke:published` from the matching source revision. This installs
   the manifest version from npm with fresh caches, configures OpenCode by the
   exact package name/version, and runs the native suite. It cannot fall back to
   the local build or the tested prepublication archive.
3. Only after actual registry installation succeeds, mark the published-package
   scenario complete and update release status in the changelog. Review the matching
   GitHub draft and its existing source tag, add links to npm and the tested
   workflow run, and publish the draft manually. Do not create a second tag or
   replace a tag created by the draft workflow.

Restart the terminal client after upgrading its TUI companion. If registry
verification fails, investigate and prepare a corrected version; do not claim a
successful release check or reuse a published version.

References: [npm staged publishing](https://docs.npmjs.com/staged-publishing/),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[trust configuration CLI](https://docs.npmjs.com/cli/v11/commands/npm-trust/),
[GitHub required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks),
and [OpenCode package plugins](https://opencode.ai/v2/docs/build/plugins/#publish).
