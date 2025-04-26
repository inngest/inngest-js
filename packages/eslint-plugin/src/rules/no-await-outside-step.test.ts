import { RuleTester } from "@typescript-eslint/rule-tester";
import { noAwaitOutsideSteps } from "./no-await-outside-step";

const ruleTester = new RuleTester({
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: "module",
  },
});

ruleTester.run("no-await-outside-steps", noAwaitOutsideSteps, {
  valid: [
    // Non-Inngest functions (no 'step' param) - should ignore
    `async function regularFunction() {
      const data = await fetch('https://api.example.com');
      return data;
    }`,

    // Proper step usage in Inngest function
    `const myFunction = inngest.createFunction(
      { id: 'test' },
      { event: 'test.event' },
      async ({ event, step }) => {
        const data = await step.run('fetch-data', async () => {
          const result = await fetch('https://api.example.com');
          return await result.json();
        });
        return { success: true, data };
      }
    )`,

    // Multiple step.run calls, properly using await inside callbacks
    `async function handler({ step }) {
      const a = await step.run("step-a", async () => {
        const data = await fetch('/api/a');
        return data;
      });
      
      const b = await step.run("step-b", async () => {
        const data = await fetch('/api/b');
        return data;
      });
      
      return { a, b };
    }`,

    // Other step functions (not just run)
    `async function handler({ step }) {
      const result = await step.waitForEvent("wait-for-event", { event: "user.created" });
      
      await step.sleep("wait-a-bit", "1h");
      
      await step.invoke("do-things", {
        first: async () => {
          const data = await fetch('/api');
          return data;
        }
      });
      
      return { success: true };
    }`,

    // Test for step.sleepUntil
    `async function handler({ step }) {
      await step.sleepUntil("wait-until-timestamp", new Date("2023-12-31"));
      
      await step.sleepUntil("wait-with-callback", async () => {
        const targetDate = await fetchTargetDate();
        return new Date(targetDate);
      });
      
      return { success: true };
    }`,

    // More comprehensive test for step.invoke
    `async function handler({ step }) {
      // Simple invoke
      await step.invoke("invoke-function", "my.function");
      
      // Invoke with data
      await step.invoke("invoke-with-data", "process.order", { orderId: "123" });
      
      // Invoke with callback for data
      await step.invoke("invoke-with-callback", "analyze", async () => {
        const data = await fetchAnalysisData();
        return { analysisData: data };
      });
      
      return { success: true };
    }`,

    // Test for step.waitForEvent
    `async function handler({ step }) {
      const event = await step.waitForEvent("wait-for-user-login", { 
        event: "user.login",
        match: { userId: "123" }
      });
      
      // With timeout
      const paymentEvent = await step.waitForEvent("wait-for-payment", {
        event: "payment.processed",
        timeout: "10m",
        match: async () => {
          const criteria = await fetchMatchCriteria();
          return criteria;
        }
      });
      
      return { received: true };
    }`,
  ],

  invalid: [
    // Basic case: await directly in handler
    {
      code: `async function handler({ step }) {
        const data = await fetch('https://api.example.com');
        return data;
      }`,
      errors: [{ messageId: "no-await-outside-steps" }],
    },

    // Multiple awaits outside steps
    {
      code: `async function processOrder({ step }) {
        const order = await fetchOrder();
        const user = await fetchUser();
        
        return await step.run("process", async () => {
          // This await is fine
          return await processData(order, user);
        });
      }`,
      errors: [
        { messageId: "no-await-outside-steps" },
        { messageId: "no-await-outside-steps" },
      ],
    },

    // Using await in return statement outside step
    {
      code: `const myFunction = inngest.createFunction(
        { id: 'test' },
        { event: 'test.event' },
        async ({ step }) => {
          const id = step.run("get-id", () => "123");
          return await getResult(id);
        }
      )`,
      errors: [{ messageId: "no-await-outside-steps" }],
    },

    // Mix of valid and invalid awaits
    {
      code: `async function handler({ event, step }) {
        // Invalid - outside step
        const config = await getConfig();
        
        // Valid - inside step.run
        const user = await step.run("get-user", async () => {
          return await fetchUser(event.userId);
        });
        
        // Invalid - outside step
        const permissions = await getPermissions(user.id);
        
        return { user, permissions };
      }`,
      errors: [
        { messageId: "no-await-outside-steps" },
        { messageId: "no-await-outside-steps" },
      ],
    },

    // Object destructuring for step
    {
      code: `async ({ 
        step,
        event 
      }) => {
        const data = await fetch('/api/data');
        await step.run("process", () => {
          // Valid await inside step
          return Promise.resolve(data);
        });
      }`,
      errors: [{ messageId: "no-await-outside-steps" }],
    },
  ],
});
