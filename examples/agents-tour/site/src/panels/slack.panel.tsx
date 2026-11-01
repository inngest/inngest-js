/**
 * @module
 * Registers the Slack panel.
 */
import { registerPanel } from "./registry.ts";
import { Slack } from "./Slack.tsx";

registerPanel({
  id: "slack",
  label: "Slack",
  key: "slack",
  focus: ".slack-head button",
  actions: ["slackCompose", "slackNew", "approve", "deny"],
  component: () => {
    return <Slack />;
  },
});
