# A Slack agent

`slack.thread` starts the agent from a Slack message, one thread per Slack thread. The message arrives in the inbox as the `slack/message` event, and its `data.text` is what was typed. `report` posts back into that thread.

Run it: the tour says "Hello" in `#eng`. Open the **Slack** tab to see the reply, then press **Mention the bot** or **Reply in thread**.
