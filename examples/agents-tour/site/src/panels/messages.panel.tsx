/**
 * @module
 * Registers the Messages panel.
 */
import { MessagePanel } from "./Messages.tsx";
import { registerPanel } from "./registry.ts";

registerPanel({
  id: "message",
  label: "Messages",
  key: "message",
  focus: ".message button",
  actions: ["sendOther", "sendEvent"],
  component: ({ page, live }) => {
    const target = page.manifest.message;

    return target ? <MessagePanel target={target} disabled={!live} /> : null;
  },
});
