/**
 * @module
 * Registers the Messages panel.
 */
import { MessagePanel } from "./Messages.tsx";
import { registerPanel } from "./registry.ts";

registerPanel({
  id: "message",
  label: "Messages",
  focus: ".message button",
  component: ({ page, live }) => {
    const target = page.manifest.message;

    return target ? <MessagePanel target={target} disabled={!live} /> : null;
  },
});
