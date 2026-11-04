/**
 * @module
 * EXPERIMENTAL: shared tools in an agent's tool list. At the start of a run the
 * shared tools that the agent's `discovery.tools` allows, from its own app and
 * from the cards other apps announced, become tools of the model's loop. Each
 * call invokes the hosted function as a durable step and returns its result
 * in the same turn.
 */

import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import { step } from "../../../components/InngestStepTools.ts";
import {
  invokeHostedTool,
  type JsonSchemaObject,
  type SandboxTools,
} from "../../../components/sandbox/tools.ts";
import type { Logger } from "../../../middleware/logger.ts";
import { limitStateOf } from "../agent/limits.ts";
import {
  type AgentCard,
  type AgentDiscovery,
  cardsOf,
  currentCards,
  mayUse,
} from "./discovery.ts";
import { defaultDiscovery, matchesDiscovery } from "./match.ts";

const appOfAddress = (address: string): string => {
  return address.slice(0, address.indexOf("/"));
};

const idOfAddress = (address: string): string => {
  return address.slice(address.indexOf("/") + 1);
};

/**
 * Whether a run of an agent of `appId` may read the cards of other apps: the
 * agent's own list can name one. The inherited lists only narrow it.
 */
const reachesOtherApps = (
  entries: NonNullable<Extract<AgentDiscovery, object>["tools"]>,
  appId: string,
): boolean => {
  return entries.some((entry) => {
    const address =
      typeof entry === "string"
        ? entry
        : "address" in entry && typeof entry.address === "string"
          ? entry.address
          : undefined;

    if (address !== undefined) {
      return appOfAddress(address) !== appId;
    }

    const app = (entry as { app?: string }).app;

    return app === undefined || (app !== "self" && app !== appId);
  });
};

/**
 * A tool name a model API accepts, from a function ID.
 */
const nameOf = (text: string): string => {
  const clean = text.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64);

  return /^[A-Za-z]/.test(clean) ? clean : `t_${clean}`.slice(0, 64);
};

/**
 * The shared tools an agent's model may call, by tool name. A card must pass
 * every list the chain of starting agents passed down and the agent's own
 * `discovery.tools` (or the default), like `discovery.agents`. A tool is named
 * by its ID with other characters turned to `_`, or `<app>_<id>` when that
 * name is taken.
 *
 * Reads the announced cards of other apps once, as a durable step, and only
 * when the agent's own list can reach another app. A read that fails leaves
 * the agent with the tools of its own app and logs a warning.
 */
export const sharedToolsFor = async (
  client: Inngest.Any,
  discovery: AgentDiscovery | undefined,
  options: {
    /**
     * Names the loop already has.
     */
    taken: ReadonlySet<string>;

    /**
     * Addresses of shared tools the agent lists in its own `tools`, so they
     * are not added twice.
     */
    listed: ReadonlySet<string>;

    /**
     * Where a failed read of other apps' cards is reported.
     */
    logger?: Logger;
  },
): Promise<SandboxTools> => {
  if (discovery === false) {
    return {};
  }

  const appId = client.id;
  const own = discovery?.tools ?? defaultDiscovery;
  const instance = getAsyncCtxSync()?.execution?.instance;
  const chain =
    (instance ? limitStateOf(instance, undefined) : undefined)?.limits.discovery
      ?.tools ?? [];
  const lists = [...chain, own];
  const mine = cardsOf(appId).filter((card) => {
    return card.kind === "tool";
  });
  let others: AgentCard[] = [];

  if (reachesOtherApps(own, appId)) {
    others = (await step.run("discover:tools", async () => {
      try {
        return (await currentCards(client)).filter((card) => {
          return card.kind === "tool" && appOfAddress(card.address) !== appId;
        });
      } catch (error) {
        options.logger?.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "Could not read shared tools from other apps; the agent has only its own app's",
        );

        return [];
      }
    })) as AgentCard[];
  }

  const allowed = [...mine, ...others].filter((card) => {
    return (
      !card.paused &&
      !options.listed.has(card.address) &&
      mayUse(card, appId) &&
      lists.every((list) => {
        return matchesDiscovery(card, list, { appId });
      })
    );
  });
  const names = new Set(options.taken);
  const tools: SandboxTools = {};

  for (const card of allowed) {
    const hostApp = appOfAddress(card.address);
    const functionId = idOfAddress(card.address);
    const name = [nameOf(functionId), nameOf(`${hostApp}_${functionId}`)].find(
      (candidate) => {
        return !names.has(candidate);
      },
    );

    if (!name) {
      continue;
    }

    names.add(name);
    tools[name] = invokeHostedTool({
      appId: hostApp,
      functionId,
      description: `${card.description ?? functionId} (shared tool ${card.address})`,
      ...(card.input && { input: card.input as JsonSchemaObject }),
    });
  }

  return tools;
};
