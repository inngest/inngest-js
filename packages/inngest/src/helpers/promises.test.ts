import { runAsPromise } from "./promises.ts";

describe("runAsPromise", () => {
  describe("synchronous functions", () => {
    describe("throwing synchronously is caught", () => {
      const fn = () => {
        throw new Error("test");
      };

      test("rejects with error", async () => {
        await expect(runAsPromise(fn)).rejects.toThrow("test");
      });
    });

    describe("resolves with value on success", () => {
      test("resolves with value", async () => {
        await expect(
          runAsPromise(() => {
            return "test";
          }),
        ).resolves.toBe("test");
      });
    });
  });

  describe("asynchronous functions", () => {
    const wait = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    describe("throwing asynchronously is caught", () => {
      test("rejects with error", async () => {
        await expect(
          runAsPromise(async () => {
            await wait(100);
            throw new Error("test");
          }),
        ).rejects.toThrow("test");
      });
    });

    describe("resolves with value on success", () => {
      test("resolves with value", async () => {
        await expect(
          runAsPromise(async () => {
            await wait(100);
            return "test";
          }),
        ).resolves.toBe("test");
      });
    });
  });

  describe("resolves with undefined if `fn` undefined", () => {
    test("resolves with undefined", async () => {
      await expect(runAsPromise(undefined)).resolves.toBeUndefined();
    });
  });

  describe("types", () => {
    describe("fn can be undefined", () => {
      test("allows undefined fn", () => {
        void runAsPromise(undefined);
      });

      test("returns undefined", () => {
        const ret = runAsPromise(undefined);
        assertType<Promise<undefined>>(ret);
      });
    });

    test("no arguments allowed", () => {
      // @ts-expect-error No arguments allowed
      void runAsPromise((_foo: string) => {
        // no-op
      });
    });

    test("returns value", () => {
      const ret = runAsPromise(() => {
        return "test";
      });

      assertType<Promise<string>>(ret);
    });
  });
});
