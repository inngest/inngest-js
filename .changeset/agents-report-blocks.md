---
"inngest": minor
---

Experimental agents: a channel message can carry surface-native rich content. `ChannelMessage.blocks` is passed through in the surface's own format (Slack: the `blocks` of `chat.postMessage`, such as feedback and follow-up buttons; the GitHub adapter ignores them and posts nothing for a message with no text); the Slack adapter rejects more than 50 blocks with a NonRetriableError before calling Slack. `report.finish({ text, blocks })` with no open stream now posts the blocks with the text, or alone, instead of dropping them.
