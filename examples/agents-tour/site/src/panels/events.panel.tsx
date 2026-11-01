/**
 * @module
 * Registers the Events panel.
 */
import { Events } from "./Events.tsx";
import { registerPanel } from "./registry.ts";

registerPanel({
  id: "events",
  label: "Events",
  key: "events",
  focus: ".events button",
  actions: ["sendEvent"],
  component: () => {
    return <Events />;
  },
});
