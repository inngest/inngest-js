/**
 * @module
 * Registers the Events panel.
 */
import { Events } from "./Events.tsx";
import { registerPanel } from "./registry.ts";

registerPanel({
  id: "events",
  label: "Events",
  focus: ".events button",
  component: () => {
    return <Events />;
  },
});
