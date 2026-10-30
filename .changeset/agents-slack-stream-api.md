---
"inngest": patch
---

Experimental agents: the Slack channel's progress stream follows Slack's API more closely. A stream starts for a user and a workspace (`recipient_user_id` from the `slack/message` event or the new `user` option, `recipient_team_id` from the new `team` option or `auth.test`) as a plan titled by the new `streamTitle` option. Only Slack's notice about the task limit counts as a dropped update; harmless notices such as `missing_charset` no longer fail a card. `message_not_found` and `cant_update_message` end a stream like `message_not_in_streaming_state` does, so the reporter starts a new one.
