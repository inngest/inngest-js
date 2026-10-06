# render

How `inngest-ci` draws a session. Both renderers only see `SessionEvent`s (`../events.ts`).

- `model.ts`: the pure reducer from events to a view model (stages, runs, jobs, commands). The latest message per key wins. A `targets` event starts a new set of runs.
- `view.ts`: the model as the lines of one frame, cut to the width. Pure, so it's tested at a fixed width.
- `format.ts`: colour (off without a TTY or with `NO_COLOR`), durations, truncation, status icons and `compose()` for styled segments.
- `interactive.ts`: redraws the frame in place, handles keys and restores the terminal on every exit path. It also asks the session's questions (the picker and prompts from `../prompt/`) in the same frame, and stays open after the runs end.
- `plain.ts`: one line per transition for logs and agents.
- `stateFile.ts`: writes the model as a session state file, atomically and throttled. Always attached beside the visible renderer.
- `open.ts`: opens a URL in the browser: `open`, `rundll32`, `xdg-open`, and on WSL `wslview` or `explorer.exe`. It says whether it worked.
