# Native UI captures

These screenshots show the full OpenCode terminal viewport with AutoCode's native
popup over the surrounding application. They were captured on 20 October 2026
from source commit `0ef61c1dded4258f3b4f36841e19426dc5a9c63a`, using AutoCode
`0.1.0-beta.2`, OpenCode `2.0.28`, Node.js `26.3.0`, and Python `3.14.0` on
macOS arm64.

- `settings.png` shows `/autocode config` with AutoCode's default settings. No
  settings were changed or saved.
- `review-log.png` shows the review details opened from `/autocode log`, including
  the reviewer verdict, model, reason, duration, and demonstration session ID.

The capture used a fresh disposable project, HOME, OpenCode profile, database,
configuration, cache, data, and state directories. A loopback scripted provider
returned an ALLOW verdict for an imported harmless `printf docs-check` transcript.
This exercised the real native permission hook and persisted one review entry.
Importing the transcript did not execute a process; the visible conversation
explicitly labels the tool output as a recorded fixture. Its model verdict and
45 ms duration illustrate the interface, not real-provider quality or latency.
The provider received exactly one tool-free review request. Opening the dialogs
made no additional model requests.

The OpenCode client ran in a fresh 100-column by 38-row PTY. Its actual emitted
terminal stream was decoded with pexpect `4.9.0` and pyte `0.8.2`, then every cell
of the viewport was rendered with Pillow `11.3.0`, Menlo at 18 px, and 11 by 24 px
cells. Both PNGs are 1100 by 912 px. Characters, colours, highlighting, positions,
and native text truncation come from the recorded cell buffer. Neither image was
cropped to the popup; no interface text or controls were invented, rearranged,
or retouched. The surrounding example conversation, Build/model footer, and
disposable project path are part of the actual native viewport.

No existing user profile, personal conversation, account credentials, desktop
capture, paid model, or real provider was used. The temporary client, native
server, and fixture provider were stopped after capture. The images are
provided under the repository's MIT licence.

SHA-256:

```text
f0825df36728e679f8260cbcf7b4439a0d9de4eae3a7093b4c2f1e42fb93cd8f  settings.png
c1f633344259b389f19e2006ee0edbb0bced3f4244675b8c8b656ec8fd4e3d6e  review-log.png
```

## Logo assets

`logo-dark.svg` and `logo-light.svg` preserve the supplied AutoCode wordmark and green approval badge. `logo.svg` uses the same dark-variant paths and palette, with an accessible title, 18 px padding and a fixed dark background so the README header remains readable on both light and dark pages. No external fonts, scripts or resources are used.
