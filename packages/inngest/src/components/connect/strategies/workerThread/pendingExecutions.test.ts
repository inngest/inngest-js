import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createLogger } from "../core/test-helpers.ts";
import {
  ConnectExecutionTimeoutError,
  PendingExecutions,
} from "./pendingExecutions.ts";

const timeoutMs = 1_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("timeout", async () => {
  const logger = createLogger();
  const pendingExecutions = new PendingExecutions({ logger, timeoutMs });
  const requestId = "my-request-id";

  const p = pendingExecutions.wait(requestId);
  expect(pendingExecutions.size).toBe(1);

  // Times out
  const expectation = expect(p).rejects.toBeInstanceOf(
    ConnectExecutionTimeoutError,
  );
  await vi.advanceTimersByTimeAsync(timeoutMs);
  await expectation;
  expect(pendingExecutions.size).toBe(0);
  expect(logger.warn).toHaveBeenCalledWith(
    {
      requestId,
      timeoutMs,
    },
    "Execution request timed out waiting for main thread response",
  );
});

test("resolve", async () => {
  const logger = createLogger();
  const pendingExecutions = new PendingExecutions({ logger, timeoutMs });
  const response = new Uint8Array([1, 2, 3]);

  const expectation = expect(pendingExecutions.wait("req-ok")).resolves.toEqual(
    response,
  );

  // Successful response
  pendingExecutions.resolve("req-ok", response);

  await expectation;
  expect(pendingExecutions.size).toBe(0);

  // Timeout is irrelevant
  await vi.advanceTimersByTimeAsync(timeoutMs);
  expect(logger.warn).not.toHaveBeenCalled();
});

test("reject", async () => {
  const logger = createLogger();
  const pendingExecutions = new PendingExecutions({ logger, timeoutMs });
  const error = new Error("main thread execution failed");

  const expectation = expect(
    pendingExecutions.wait("req-error"),
  ).rejects.toThrow(error.message);

  // Unsuccessful response
  pendingExecutions.reject("req-error", error);

  await expectation;
  expect(pendingExecutions.size).toBe(0);

  // Timeout is irrelevant
  await vi.advanceTimersByTimeAsync(timeoutMs);
  expect(logger.warn).not.toHaveBeenCalled();
});

test("wait rejects duplicate request IDs", async () => {
  const logger = createLogger();
  const pendingExecutions = new PendingExecutions({ logger, timeoutMs });
  const response = new Uint8Array([1, 2, 3]);

  const expectation = expect(
    pendingExecutions.wait("req-duplicate"),
  ).resolves.toEqual(response);

  // Duplicate call throws
  expect(() => pendingExecutions.wait("req-duplicate")).toThrow(
    "Pending execution already exists: req-duplicate",
  );

  // Successful response
  pendingExecutions.resolve("req-duplicate", response);

  await expectation;
  expect(pendingExecutions.size).toBe(0);

  // Timeout is irrelevant
  await vi.advanceTimersByTimeAsync(timeoutMs);
  expect(logger.warn).not.toHaveBeenCalled();
});
