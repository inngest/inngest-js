import { z } from "zod/v3";
import { DEV_SERVER_URL } from "./devServer.ts";
import { waitFor } from "./utils.ts";

const fetchEventSchema = z.object({
  data: z.object({
    eventV2: z.object({
      idempotencyKey: z.string().optional(),
      name: z.string(),
      raw: z.string(),
    }),
  }),
});

/**
 * Query the Dev Server's GraphQL API for an event with the given ID.
 * Polls until the event appears, then returns its parsed payload.
 */
export async function fetchEvent(id: string): Promise<{
  data: Record<string, unknown>;
  idempotencyKey: string | null;
  name: string;
}> {
  return waitFor(async () => {
    const res = await fetch(`${DEV_SERVER_URL}/v0/gql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query Event($id: ULID!) {
          eventV2(id: $id) {
            idempotencyKey
            name
            raw
          }
        }`,
        variables: { id },
        operationName: "Event",
      }),
    });

    if (!res.ok) {
      throw new Error(
        `Dev Server GraphQL query failed: ${res.status} ${await res.text()}`,
      );
    }

    const raw = await res.json();
    const parsed = fetchEventSchema.parse(raw).data.eventV2;

    const data = JSON.parse(parsed.raw).data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error("Event data is not a record");
    }

    return {
      data: data as Record<string, unknown>,
      idempotencyKey: parsed.idempotencyKey ?? null,
      name: parsed.name,
    };
  });
}
