# render

How `inngest-ci` draws a session. Both renderers only see `SessionEvent`s (`../events.ts`).

- `model.ts`: the pure reducer from events to a view model (stages, runs, jobs, commands). The latest message per key wins.
- `view.ts`: the model as the lines of one frame, cut to the width. Pure, so it's tested at a fixed width.
- `format.ts`: colour (off without a TTY or with `NO_COLOR`), durations, truncation and status icons.
- `interactive.ts`: redraws the frame in place, handles keys and restores the terminal on every exit path.
- `plain.ts`: one line per transition for logs and agents.
- `open.ts`: opens a URL in the browser.
