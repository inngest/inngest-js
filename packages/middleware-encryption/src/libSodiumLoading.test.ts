import { fromPartial } from "@total-typescript/shoehorn";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { EncryptionMiddlewareOptions } from "./middleware";

const sodiumLoads = vi.fn();

const createMiddleware = async (opts: EncryptionMiddlewareOptions) => {
  const { encryptionMiddleware } = await import("./middleware");
  const MW = encryptionMiddleware(opts);
  return new MW({ client: fromPartial({}) });
};

const sendEvent = async (mw: Awaited<ReturnType<typeof createMiddleware>>) => {
  const result = await mw.transformSendEvent!({
    events: [{ name: "my.event", data: { encrypted: { secret: "data" } } }],
    fn: null,
  });

  return result.events[0].data?.encrypted;
};

describe("libsodium loading", () => {
  beforeEach(() => {
    vi.resetModules();
    sodiumLoads.mockReset();
    vi.doMock("libsodium-wrappers", async (importOriginal) => {
      sodiumLoads();
      return importOriginal();
    });
  });

  test("never loads with a custom encryptionService", async () => {
    const mw = await createMiddleware({
      key: "",
      encryptionService: {
        identifier: "custom",
        encrypt: (value) => JSON.stringify(value),
        decrypt: (value) => JSON.parse(value),
      },
    });

    expect(await sendEvent(mw)).toMatchObject({ data: '{"secret":"data"}' });
    expect(sodiumLoads).not.toHaveBeenCalled();
  });

  test("loads on first use of the default service", async () => {
    const mw = await createMiddleware({ key: "key" });
    expect(sodiumLoads).not.toHaveBeenCalled();

    expect(await sendEvent(mw)).toMatchObject({
      __STRATEGY__: "inngest/libsodium",
    });
    expect(sodiumLoads).toHaveBeenCalledOnce();
  });

  test("retries after a failed load", async () => {
    vi.doMock("libsodium-wrappers", async (importOriginal) => {
      sodiumLoads();
      if (sodiumLoads.mock.calls.length === 1) {
        throw new Error("load failed");
      }
      return importOriginal();
    });

    const mw = await createMiddleware({ key: "key" });

    await expect(sendEvent(mw)).rejects.toThrow();
    expect(await sendEvent(mw)).toMatchObject({
      __STRATEGY__: "inngest/libsodium",
    });
  });
});
