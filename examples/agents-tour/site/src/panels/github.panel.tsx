/**
 * @module
 * Registers the GitHub panel.
 */
import { Github } from "./Github.tsx";
import { registerPanel } from "./registry.ts";

registerPanel({
  id: "github",
  label: "GitHub",
  focus: ".gh-head button",
  component: () => {
    return <Github />;
  },
});
