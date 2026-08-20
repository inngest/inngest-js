import { retryWithBackoff, runAsPromise } from "./promises.ts";

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

describe("retryWithBackoff", () => {
  describe("successful execution", () => {
    test("returns value on first attempt", async () => {
      const fn = vi.fn().mockResolvedValue("success");

      const result = await retryWithBackoff(fn);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("works with synchronous functions", async () => {
      const fn = vi.fn().mockReturnValue("sync-success");

      const result = await retryWithBackoff(fn);

      expect(result).toBe("sync-success");
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("retry behavior", () => {
    test("retries on failure and succeeds", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail1"))
        .mockRejectedValueOnce(new Error("fail2"))
        .mockResolvedValue("success");

      const result = await retryWithBackoff(fn, {
        maxAttempts: 5,
        baseDelay: 1,
      });

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    test("exhausts all retries and throws last error", async () => {
      const lastError = new Error("final failure");
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail1"))
        .mockRejectedValueOnce(new Error("fail2"))
        .mockRejectedValue(lastError);

      await expect(
        retryWithBackoff(fn, { maxAttempts: 3, baseDelay: 1 }),
      ).rejects.toThrow("final failure");
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe("configuration", () => {
    test("respects maxAttempts option", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("always fails"));

      await expect(
        retryWithBackoff(fn, { maxAttempts: 2, baseDelay: 1 }),
      ).rejects.toThrow("always fails");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test("uses default maxAttempts of 5", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("always fails"));

      await expect(retryWithBackoff(fn, { baseDelay: 1 })).rejects.toThrow(
        "always fails",
      );
      expect(fn).toHaveBeenCalledTimes(5);
    });
  });

  describe("exponential backoff", () => {
    test("delays increase exponentially between retries", async () => {
      vi.useFakeTimers();

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail1"))
        .mockRejectedValueOnce(new Error("fail2"))
        .mockResolvedValue("success");

      const promise = retryWithBackoff(fn, { maxAttempts: 5, baseDelay: 100 });

      // First attempt happens immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);

      // After first failure, wait for backoff (100ms base + up to 100ms jitter)
      await vi.advanceTimersByTimeAsync(200);
      expect(fn).toHaveBeenCalledTimes(2);

      // After second failure, wait for backoff (200ms base + up to 100ms jitter)
      await vi.advanceTimersByTimeAsync(300);
      expect(fn).toHaveBeenCalledTimes(3);

      const result = await promise;
      expect(result).toBe("success");

      vi.useRealTimers();
    });
  });
});
