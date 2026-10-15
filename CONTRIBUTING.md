# Contributing to AutoCode

Use Node.js 22.18 or newer and npm. This project targets the OpenCode v2 plugin API and is tested with OpenCode 2.0.28.

```sh
npm ci
npm run check
```

`check` runs TypeScript checking, unit tests, and the production build. Keep changes focused and include a regression test for changed behavior. Permission failures must continue to require manual review or reject the request; they must never create an automatic approval.

## Native integration test

With an OpenCode v2 binary installed:

```sh
npm run smoke
```

The smoke test packs and installs AutoCode in a temporary global configuration, starts an isolated OpenCode server, and uses a local fake provider. It checks inherited and separate reviewers, hard rejection precedence, the settings command, model choices, and settings persistence. The fake reviewer always returns `allow`, so rejection checks test OpenCode's enforcement independently of model judgment.

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
The unpublished plugin is installed from its local tarball, and all model traffic
still uses the local fake provider. `npm run release:check` combines project checks,
this installation check, and a package contents preview. CI runs checks on Node.js
22 and 24 and native installation on Linux and macOS with OpenCode 2.0.28.

## Opt-in real provider validation

Keep a local OpenCode server running with this checkout registered globally, and explicitly select a connected coding model and, optionally, a separate reviewer:

```sh
npm run test:live -- --model provider/model --variant variant --reviewer provider/reviewer
```

Replace the placeholders with models available through your existing OpenCode connection and a supported variant. Omit `--reviewer` to skip the separate reviewer case. The variant defaults to `low` if omitted. Use `--server http://127.0.0.1:PORT` if your local server uses a different address from the default `http://127.0.0.1:49374`.

This check makes real model calls and incurs normal provider costs. It reads the local OpenCode service credentials and only permits loopback servers. It uses temporary conversations and project settings, executes a harmless `printf`, and evaluates destructive or adversarial examples as imported transcripts without executing those commands. It checks authorized commands, unknown scripts, unrelated and prohibited deletion, prompt injection, and a separate reviewer when requested. Reports are written under the ignored `.live-validation/` directory.

## Packaging and releases

Run `npm pack --dry-run` to inspect the package contents; the prepack hook builds the distributable. Use the [release checklist](RELEASING.md) before publishing. The current beta is prepared but has not been published.

Submit focused changes through [GitHub](https://github.com/expiracy/autocode). Include what changed and the checks you actually ran. Contributions use the project's [MIT license](LICENSE).
