# Settings image

`settings.png` shows the actual AutoCode settings dialog in OpenCode 2.0.28.
It was captured from a native terminal running `/autocode settings`, with a
disposable project and isolated configuration, data, cache, and state directories.
The fixture used AutoCode's defaults and local model metadata; no model generation
was requested and no account credentials or personal session data were loaded.

The terminal ran at 120 columns by 40 rows. Its recorded VT output was parsed by
pyte 0.8.2, then rendered with Pillow using the recorded characters, foreground and
background colors, and bold attributes. The PNG is cropped to the native dialog's
60-column by 15-row bounds and uses Menlo at 18 px. The dialog text and layout were
not recreated or edited.
