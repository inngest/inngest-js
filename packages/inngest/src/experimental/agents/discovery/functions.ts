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

/**
 * Reads the functions of `app`. An app the platform does not know has none.
 * Any other failure throws an error that says what failed.
 */
export const readAppFunctions = async (
  client: Inngest.Any,
  app: string,
): Promise<AppFunctions> => {
  const url = new URL(
    `/v2/apps/${encodeURIComponent(app)}/functions`,
    client.apiBaseUrl,
  );
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
    return new Map();
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
  const found: AppFunctions = new Map();

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

  return found;
};
