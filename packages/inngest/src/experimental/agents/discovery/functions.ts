/**
 * @module
 * EXPERIMENTAL: reads whether the functions of an app are paused or archived
 * (`GET /v2/apps/{app}/functions`), for discovery's current cards and for
 * `start_agent`'s check just before it starts an agent.
 */

import type { Inngest } from "../../../components/Inngest.ts";
import { fetchWithAuthFallback } from "../../../helpers/net.ts";
import { hashSigningKey } from "../../../helpers/strings.ts";

/**
 * What the platform says about one function.
 */
export interface FunctionStatus {
  paused: boolean;
  archived: boolean;
}

/**
 * The function status of every function of an app, by function ID within the
 * app (the agent ID, without the `"<app>-"` prefix).
 */
export type AppFunctions = Map<string, FunctionStatus>;

const pageSize = 100;
const maxPages = 50;

/**
 * Reads the functions of `app`, page by page. An app the platform does not know has none.
 * Any other failure throws an error that says what failed.
 */
export const readAppFunctions = async (
  client: Inngest.Any,
  app: string,
): Promise<AppFunctions> => {
  const found: AppFunctions = new Map();
  let cursor: string | undefined;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(
      `/v2/apps/${encodeURIComponent(app)}/functions`,
      client.apiBaseUrl,
    );

    url.searchParams.set("limit", String(pageSize));

    if (cursor !== undefined) {
      url.searchParams.set("cursor", cursor);
    }

    const res = await fetchWithAuthFallback({
      authToken: hashSigningKey(client.signingKey),
      authTokenFallback: client.signingKeyFallback
        ? hashSigningKey(client.signingKeyFallback)
        : undefined,
      fetch: client.fetch,
      url,
      options: { headers: { ...client.headers } },
    });

    if (res.status === 404) {
      return found;
    }

    if (!res.ok) {
      throw new Error(
        `Reading the functions of "${app}" failed: ${res.status} ${res.statusText}`,
      );
    }

    const body = (await res.json()) as unknown;
    const list = Array.isArray(body)
      ? body
      : ((body as { data?: unknown[] } | undefined)?.data ?? []);

    for (const entry of list) {
      const fn = entry as {
        slug?: string;
        id?: string;
        name?: string;
        is_paused?: boolean;
        is_archived?: boolean;
      };
      const id = fn.slug ?? fn.id ?? fn.name;

      if (!id) {
        continue;
      }

      found.set(id.startsWith(`${app}-`) ? id.slice(app.length + 1) : id, {
        paused: fn.is_paused === true,
        archived: fn.is_archived === true,
      });
    }

    const next = (
      body as { page?: { cursor?: string | null; hasMore?: boolean } } | null
    )?.page;

    if (!next?.hasMore || !next.cursor) {
      return found;
    }

    cursor = next.cursor;
  }

  throw new Error(
    `The app "${app}" has more than ${maxPages} pages of functions, so its agents cannot all be checked.`,
  );
};

/**
 * Whether an agent can be started right now.
 */
export type Startability = { ok: true } | { ok: false; reason: string };

/**
 * Looks at the function behind `address` (`"<app>/<agent>"`) again, and says
 * whether it can be started: a paused, archived or missing function is
 * refused with a reason a model can read. `start_agent` asks just before it
 * starts; discovery's cards may be hours old.
 */
export const startability = async (
  client: Inngest.Any,
  address: string,
  read: (app: string) => Promise<AppFunctions> = (app) => {
    return readAppFunctions(client, app);
  },
): Promise<Startability> => {
  const slash = address.indexOf("/");
  const app = address.slice(0, slash);
  const agent = address.slice(slash + 1);
  const status = (await read(app)).get(agent);

  if (!status) {
    return {
      ok: false,
      reason: `Agent "${address}" no longer exists, so it was not started. Use list_agents to find another.`,
    };
  }

  if (status.archived) {
    return {
      ok: false,
      reason: `Agent "${address}" is archived, so it was not started. Use list_agents to find another.`,
    };
  }

  if (status.paused) {
    return {
      ok: false,
      reason: `Agent "${address}" is paused, so it was not started. Use list_agents to find another, or tell the person it is paused.`,
    };
  }

  return { ok: true };
};
