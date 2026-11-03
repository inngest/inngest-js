# What started it

The body of an agent can read the message that started the run. Let's have `hello` return what was sent: the body receives `event`, and `event.data.content` is the text of the message.

Press {Run}. Run calls the code in `run.ts`, which starts `hello` with the message `"Hi"`. Then press {sendEvent} in the Messages panel to send `hello` a different message.

In the Trace, the run from Run returns `"You said: Hi"`, and the new run above it returns `"You said: "` followed by the message from the Messages panel. To see that message as sent, click the first row of the new run, the message: the event is there, with the text in `content`.
