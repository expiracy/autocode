# Native UI captures

`settings.png` shows the actual AutoCode settings dialog opened with
`/autocode config` in OpenCode 2.0.28. `review-log.png` shows the native review
details dialog opened from `/autocode log`.

Both captures used a disposable project and isolated configuration, data, cache,
and state directories. The settings retain AutoCode's defaults. The log entry came
from an actual native permission review of an imported harmless `printf` fixture,
using a local fake provider that returned an ALLOW verdict. The imported transcript
did not execute a process. No real provider, account credentials, or personal
session data were used. Opening the dialogs made no additional model requests.

The terminal ran at 120 columns by 40 rows. Its recorded VT output was parsed by
pyte 0.8.2, then rendered with Pillow using the recorded characters, foreground and
background colors, and bold attributes. Each PNG is cropped to the native dialog's
60-column bounds and uses Menlo at 18 px. The settings image covers 18 rows; the
review details image covers 16 rows. The dialog text and layout were not recreated
or edited.
