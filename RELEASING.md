# Releasing AutoCode

The prepared package is `opencode-autocode@0.1.0-beta.1`, licensed under MIT.
It has **not been published**. The package defaults to public access on npm with
the `next` distribution tag. The workflows in this repository run checks and
produce artifacts only: they have no npm publishing step, credentials, or OIDC
write permission.

## Prepare and inspect

Use Node.js 22.18 or newer, npm, and OpenCode 2.0.28. From a clean checkout:

```sh
npm ci
npm run release:check
```

`release:check` runs type checking, all unit tests, a build, the complete native
smoke suite with a fresh npm cache and ordinary dependency resolution, and a
package contents preview. It needs registry access to install dependencies.
All model traffic stays on a local fake provider, and OpenCode uses temporary
configuration and data directories. It does not use your installed provider
connections or change your OpenCode configuration.

The default `npm run smoke` remains an offline installation check after `npm ci`.
The release check additionally installs only the packed plugin, with lifecycle
scripts disabled, to verify the published JavaScript needs no consumer build.
Native checks cover inherited and separate reviewers, settings persistence,
compound commands, saved approvals, hard policies, and actual blocked execution.

Build a tarball for inspection:

```sh
npm pack
tar -tzf opencode-autocode-0.1.0-beta.1.tgz
```

Check the name, version, MIT licence, README, example configuration, root server
and TUI entrypoints, generated JavaScript, type declarations, and dependencies.
No local sessions, validation reports, caches, credentials, or test fixtures belong
in the tarball. `prepack` builds the package, while `prepublishOnly` runs the
project checks for a workspace publication.

CI runs project checks on Node.js 22 and 24 and native installation checks on
Linux and macOS against OpenCode 2.0.28. The manually dispatched **Prepare release**
workflow reruns those checks and uploads the tarball and its npm file manifest,
identified by the source commit. It never publishes to npm or creates a GitHub
release. Review its actual run results before treating CI as verified.

## First publication, when approved

Publication requires a separate decision after preparation. The following steps
are for that later release:

1. Check `npm view opencode-autocode` again and verify the intended npm account
   can publish that name. A previous 404 does not reserve it or guarantee that npm
   will accept it.
2. Use an npm account with two-factor authentication. Sign in interactively with
   `npm login` and check the account with `npm whoami`.
3. Update the unpublished notices in the README, example, contributing guide,
   changelog, and this document as part of the release commit. Date the changelog,
   confirm the manifest and lockfile agree on `0.1.0-beta.1`, and rerun preparation
   for that exact commit.
4. Publish the inspected tarball with its prerelease tag:

   ```sh
   npm publish ./opencode-autocode-0.1.0-beta.1.tgz --access public --tag next
   ```

5. Verify registry metadata and the `next` tag. In a new isolated OpenCode profile,
   load `opencode-autocode@0.1.0-beta.1` directly by package name, open and save
   `/autocode config`, run a harmless authorized `printf`, and inspect its review
   with `/autocode log`. The prepublication
   tarball checks cannot verify public registry name resolution before the package
   exists.
6. Tag the source commit `v0.1.0-beta.1` and create matching GitHub release notes.

A published name/version combination cannot be reused, even after unpublishing.
Correct mistakes with a new version. Keep the beta under `next`; choose a
separate stable version and explicitly select `latest` when ready for general
installation.

## Subsequent releases

Configure npm trusted publishing for the public `expiracy/autocode` repository
after the package exists. A future publishing workflow should use a GitHub-hosted
runner, a supported npm CLI, `contents: read` and `id-token: write`, and the exact
workflow filename configured in npm. Keep the manifest's repository URL aligned
with this repository. Trusted publishing from a public GitHub repository provides
provenance without storing a long-lived npm publish token.

The existing **Prepare release** workflow is deliberately not a publishing
workflow. Enabling publishing, configuring the npm account, and choosing who can
authorize releases remain separate from preparing this checkout.

For each update, change the package and lockfile versions together, record user
visible changes, rerun the release checks, inspect the tarball, and test the
OpenCode versions claimed by that release. Restart the terminal client after
upgrading its TUI companion.

References: [npm publishing](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/),
[distribution tags](https://docs.npmjs.com/adding-dist-tags-to-packages/),
[trusted publishing](https://docs.npmjs.com/trusted-publishers/), and
[OpenCode package plugins](https://opencode.ai/v2/docs/build/plugins/#publish).
