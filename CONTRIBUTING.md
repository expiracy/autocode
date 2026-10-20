# Contributing to AutoCode

Use Node.js 22.18 or newer and npm. This project targets the OpenCode v2 plugin API and is tested with OpenCode 2.0.28 on Linux and macOS. CI checks Node.js 22.18 and 24; Windows host integration is not part of the verified support matrix.

```sh
npm ci --ignore-scripts
npm run check
npm run lint:workflows
```

`check` runs TypeScript checking, unit tests, and the production build. Keep changes focused and include a regression test for changed behavior. Permission failures must continue to require manual review or reject the request; they must never create an automatic approval.

`lint:workflows` uses a pinned actionlint 1.7.12 release with checked SHA-256
digests for Linux/macOS x64 and arm64. Its first run downloads the official
archive; later runs verify the archive cached in the system temporary directory.
It does not install a global tool or require npm development dependencies.

The release-upload HTTP regression also requires GitHub CLI (`gh`) on `PATH`.
It uses an isolated configuration, a dummy token, and a loopback server; no
GitHub sign-in or remote mutation is needed.

## Native integration test

With an OpenCode v2 binary installed:

```sh
npm run smoke
```

The smoke test packs and installs AutoCode in a temporary global configuration, starts an isolated OpenCode server, and uses a local fake provider. It checks inherited and separate reviewers, hard rejection precedence, config/log/status/help commands, model choices, settings persistence, and project-scoped review history. It also verifies that directory aliases share history and logging does not turn reviewer verdicts into execution guarantees. The fake reviewer always returns `allow`, so rejection checks test OpenCode's enforcement independently of model judgment.

This test does not send model traffic to an external provider or change your installed configuration. It uses `~/.opencode/bin/opencode` when available, otherwise `opencode` on `PATH`. To select another binary:

```sh
OPENCODE_BIN=/absolute/path/to/opencode npm run smoke
```

For release preparation, also test installation with a fresh npm cache and normal
dependency and peer resolution:

```sh
npm run smoke:registry
```

This downloads package dependencies from npm and runs the same native scenarios.
The plugin under test is installed from its local tarball, and all model traffic
still uses the local fake provider. `npm run release:check` combines local release
preparation checks; the [release workflow](RELEASING.md) separately tests one
identified archive across the full CI matrix.

To run the native suite against an already built package without repacking it:

```sh
node test/smoke.mjs --artifact artifacts/package.tgz --diagnostics-dir diagnostics/native
```

The test reads package metadata from that archive, installs it with a fresh npm
cache and lifecycle scripts disabled, and loads its installed server/TUI
entrypoints. It retains sanitized host logs and result metadata when requested.
Do not upload temporary profiles, credentials, or conversation payloads.

After publishing the manifest version, verify the actual npm package and OpenCode's
registry loader with `npm run smoke:published`. This uses fresh npm and OpenCode
caches, installs by the exact package name and version, and runs the native suite
without using this checkout's built files or your provider connections.

## Opt-in real provider validation

Keep a local OpenCode server running with this checkout registered globally, and explicitly select a connected coding model and, optionally, a separate reviewer:

```sh
npm run test:live -- --model provider/model --variant variant --reviewer provider/reviewer
```

Replace the placeholders with models available through your existing OpenCode connection and a supported variant. Omit `--reviewer` to skip the separate reviewer case. The variant defaults to `low` if omitted. Use `--server http://127.0.0.1:PORT` if your local server uses a different address from the default `http://127.0.0.1:49374`.

This check makes real model calls and incurs normal provider costs. It reads the local OpenCode service credentials and only permits loopback servers. It uses temporary conversations and project settings, executes a harmless `printf`, and evaluates destructive or adversarial examples as imported transcripts without executing those commands. It checks authorized commands, unknown scripts, unrelated and prohibited deletion, prompt injection, and a separate reviewer when requested. Reports are written under the ignored `.live-validation/` directory.

## Packaging and releases

PRs, merge queues, and pushes to `main` run typechecking, tests, workflow linting,
one package build, fresh-cache artifact installation on Node.js 22.18/24, and
native OpenCode 2.0.28 integrations on Linux/macOS. The package job records its
source commit, version, licence, release channel, and checksums; all consumers
download the same immutable artifact ID. The stable **CI required** aggregate
must pass before merging. Diagnostics are retained for 14 days and the package
for 30 days; download evidence you need to keep longer.

Run `npm pack --dry-run` to inspect local package contents; its prepack hook builds
the distributable. Use the [release checklist](RELEASING.md) for delivery. The
manual **Release** workflow defaults to rehearsal. Explicit staging from `main`
uses stage-only npm OIDC and the protected `npm-staging` environment, and a human
must approve the stage at npm with 2FA. Do not add publishing tokens or automatic
final approval. Beta releases use `next`; stable releases use `latest`.

Submit focused changes through [GitHub](https://github.com/expiracy/autocode). Include what changed and the checks you actually ran. Contributions use the project's [MIT license](LICENSE).
