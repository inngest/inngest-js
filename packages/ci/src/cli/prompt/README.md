# prompt

What `inngest-ci` asks a person at a terminal. Each prompt is pure state, a reducer from keys to the next state, and a function from state to lines, so it's tested without a terminal. `render/interactive.ts` feeds them keys and draws them.

- `outcome.ts`: how a prompt ends (an answer or a cancel) and the keys that cancel.
- `picker.ts`: the picker's state: moving, selecting, opening a matrix and running.
- `pickerView.ts`: the picker as the lines of a frame, scrolling to keep the highlighted row in view.
- `choice.ts`: pick one of a few options.
- `text.ts`: type one line, with a check that can refuse it.
