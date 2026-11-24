/**
 * @module
 * Tests for announcing cards when the app syncs with Inngest.
 */
import httpMocks from "node-mocks-http";
import { z } from "zod/v4";
import { Inngest } from "../../../components/Inngest.ts";
import { invoke } from "../../../components/triggers/triggers.ts";
import { serve } from "../../../next.ts";
import { createAgents } from "../agent/agents.ts";
import { memoryKvAdapter, setAppKvStore } from "../kv/kv.ts";
import { agentsRegisteredEvent, announceIfChanged } from "./discovery.ts";

const makeApp = (id: string, description: string) => {
  const client = new Inngest({
    id,
    isDev: true,
    // The registration with the Dev Server succeeds.
    fetch: (async () => {
      return new Response(JSON.stringify({ status: 200 }), { status: 200 });
    }) as typeof fetch,
  });
  setAppKvStore(client.id, memoryKvAdapter());
  const agents = createAgents(client);

  agents.agent(
    {
      id: "helper",
      card: { description },
      triggers: invoke(z.object({ q: z.string() })),
    },
    async () => {
      return { ok: true };
    },
  );

  return { client, agents };
};

const sync = async (handler: ReturnType<typeof serve>) => {
  const req = httpMocks.createRequest({
    method: "PUT",
    url: "/api/inngest",
    headers: { host: "localhost:3000" },
  });
  const res = httpMocks.createResponse();

  await (handler as (...args: unknown[]) => Promise<unknown>)(req, res);

  return res;
};

describe("announce on sync", () => {
  test("announces once per change in cards, not on every sync", async () => {
    const { client, agents } = makeApp("sync-a", "Helps");
    const send = vi.spyOn(client, "send").mockResolvedValue({ ids: [] });

    expect(await announceIfChanged(client)).toBe("sent");
    expect(await announceIfChanged(client)).toBe("unchanged");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      name: agentsRegisteredEvent,
      data: { app: "sync-a" },
    });

    // A card that changes is announced again.
    agents.agent(
      { id: "second", triggers: invoke(z.object({ q: z.string() })) },
      async () => {
        return { ok: true };
      },
    );

    expect(await announceIfChanged(client)).toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("a failed send is reported, never thrown, and retried next time", async () => {
    const { client } = makeApp("sync-b", "Helps");
    const send = vi
      .spyOn(client, "send")
      .mockRejectedValueOnce(new Error("no event key"))
      .mockResolvedValue({ ids: [] });

    expect(await announceIfChanged(client)).toBe("failed");
    expect(await announceIfChanged(client)).toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("an app with no cards announces nothing", async () => {
    const client = new Inngest({ id: "sync-c", isDev: true });
    const send = vi.spyOn(client, "send").mockResolvedValue({ ids: [] });

    expect(await announceIfChanged(client)).toBe("unchanged");
    expect(send).not.toHaveBeenCalled();
  });

  test("a sync request makes the served app announce", async () => {
    const { client, agents } = makeApp("sync-d", "Helps");
    const send = vi.spyOn(client, "send").mockResolvedValue({ ids: [] });
    const handler = serve({ client, functions: agents.functions() });

    await sync(handler);
    await sync(handler);

    const announced = send.mock.calls.filter(([event]) => {
      return (event as { name?: string }).name === agentsRegisteredEvent;
    });

    expect(announced).toHaveLength(1);
  });

  test("a failing hook does not fail the sync", async () => {
    const { client, agents } = makeApp("sync-e", "Helps");

    vi.spyOn(client, "send").mockRejectedValue(new Error("down"));

    const res = await sync(serve({ client, functions: agents.functions() }));

    expect(res.statusCode).toBe(200);
  });
});
