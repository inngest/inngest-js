# What started it

The body of an agent can read the message that started the run. Let's have `hello` return what was sent: the body receives `event`, and `event.data.content` is the text of the message.

Press {Run}. Run calls the code in `run.ts`, which starts `hello` with the message `"Hi"`. Then type a different message in the Messages panel and press {sendEvent}.

In the Trace, the run from Run returns `"You said: Hi"`. The new run sits above that one and returns the message from the Messages panel, after `"You said: "`. Click the first row of the new run, the message, to see the event exactly as sent, with the text in `content`.
