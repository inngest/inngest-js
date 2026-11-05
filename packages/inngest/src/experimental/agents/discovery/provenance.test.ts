/**
 * @module
 * Where an agent and its tools were defined, and the tools on a card.
 */

import { z } from "zod/v4";
import { Inngest } from "../../../components/Inngest.ts";
import { tool } from "../../../components/sandbox/tools.ts";
import { createAgents } from "../agent/agents.ts";
import { memoryKvAdapter } from "../kv/kv.ts";
import { sandbox } from "../sandboxes/defs.ts";
import { announcement, summaryOf } from "./discovery.ts";

const getOrg = tool({
  id: "getOrg",
  description: "Looks up an org",
  input: z.object({ slug: z.string() }),
  run: () => {
    return {};
  },
});
const lab = sandbox({
  id: "lab",
  tools: { run: sandbox.tools.run, runCode: sandbox.tools.runCode },
});

describe("card provenance", () => {
  const make = (isDev: boolean) => {
    const client = new Inngest({ id: `prov-${isDev}`, isDev });
    const agents = createAgents(client, { store: memoryKvAdapter() });

    agents.agent({
      id: "helper",
      tools: { getOrg },
      sandboxes: { lab },
    });

    return announcement(client).data.cards[0];
  };

  test("dev mode: source and tool sources point at this file", () => {
    const card = make(true);

    expect(card?.source?.file).toMatch(/provenance\.test\.ts$/);
    expect(card?.source?.line).toBeGreaterThan(0);

    const org = card?.tools?.find((t) => t.name === "getOrg");

    expect(org?.description).toBe("Looks up an org");
    expect(org?.source?.file).toMatch(/provenance\.test\.ts$/);
    expect(org?.source?.line).toBe(14);
    expect(card?.tools?.map((t) => t.name)).toEqual(
      expect.arrayContaining(["getOrg", "lab_run", "lab_runCode"]),
    );
  });

  test("cloud mode: tools stay, sources go", () => {
    const card = make(false);

    expect(card?.source).toBeUndefined();
    expect(card?.tools?.find((t) => t.name === "getOrg")).toEqual({
      name: "getOrg",
      description: "Looks up an org",
    });
  });

  test("list_agents summaries leave them out", () => {
    const card = make(true);

    if (!card) {
      throw new Error("no card");
    }

    const summary = summaryOf(card);

    expect("source" in summary).toBe(false);
    expect("tools" in summary).toBe(false);
  });
});
