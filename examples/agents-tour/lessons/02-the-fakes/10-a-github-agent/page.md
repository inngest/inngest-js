# A GitHub agent

An agent can start from any event, here `github/issues.opened`. The event is the inbox's first message, and `message.data` holds the issue, such as `title` and `body`. `report` comments back on the issue.

Run it, then open the **GitHub** tab and press **Create issue**. The agent answers with a comment.
