/**
 * @module
 * Registers the GitHub panel.
 */
import { Github } from "./Github.tsx";
import { registerPanel } from "./registry.ts";

registerPanel({
  id: "github",
  label: "GitHub",
  key: "github",
  focus: ".gh-head button",
  actions: ["githubComment", "githubApprove", "githubPull", "githubIssue"],
  component: () => {
    return <Github />;
  },
});
