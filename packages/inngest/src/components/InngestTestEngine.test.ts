import { Inngest } from "./Inngest";
import { InngestTestEngine } from "@inngest/test";
import type { Context } from "../types";

describe("InngestTestEngine", () => {
  describe("multiple functions support", () => {
    const inngest = new Inngest({ id: "test-app" });

    const userFunction = inngest.createFunction(
      { id: "user-function" },
      { event: "user.created" },
      async ({ event }: Context.Any) => {
        return { result: "User function executed", userId: event.data.userId };
      }
    );

    const orderFunction = inngest.createFunction(
      { id: "order-function" },
      { event: "order.placed" },
      async ({ event }: Context.Any) => {
        return { result: "Order function executed", orderId: event.data.orderId };
      }
    );

    it("should auto-select the correct function based on event name", async () => {
      const testEngine = new InngestTestEngine({
        functions: [userFunction, orderFunction],
        events: [{ name: "user.created", data: { userId: "123" } }],
      });

      const result = await testEngine.execute();
      expect(result.result).toEqual({
        result: "User function executed",
        userId: "123",
      });
    });

    it("should select different function for different event", async () => {
      const testEngine = new InngestTestEngine({
        functions: [userFunction, orderFunction],
        events: [{ name: "order.placed", data: { orderId: "456" } }],
      });

      const result = await testEngine.execute();
      expect(result.result).toEqual({
        result: "Order function executed",
        orderId: "456",
      });
    });

    it("should throw error when no function matches the event", async () => {
      const testEngine = new InngestTestEngine({
        functions: [userFunction, orderFunction],
        events: [{ name: "unknown.event", data: { someData: "test" } }],
      });

      await expect(testEngine.execute()).rejects.toThrow(
        'No function found that can handle event "unknown.event"'
      );
    });

    it("should throw error when no event name is provided with multiple functions", async () => {
      const testEngine = new InngestTestEngine({
        functions: [userFunction, orderFunction],
        events: [{ name: "", data: { someData: "test" } }],
      });

      await expect(testEngine.execute()).rejects.toThrow(
        'Event name is required when multiple functions are provided for auto-selection'
      );
    });

    it("should maintain backward compatibility with single function parameter", async () => {
      const testEngine = new InngestTestEngine({
        function: userFunction,
        events: [{ name: "user.created", data: { userId: "backward" } }],
      });

      const result = await testEngine.execute();
      expect(result.result).toEqual({
        result: "User function executed",
        userId: "backward",
      });
    });
  });
});
