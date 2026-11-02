/**
 * @module
 * Registers the Slack panel.
 */
import { registerPanel } from "./registry.ts";
import { Slack } from "./Slack.tsx";

registerPanel({
  id: "slack",
  label: "Slack",
  focus: ".slack-head button",
  component: () => {
    return <Slack />;
  },
});
