import { ESLintUtils } from "@typescript-eslint/utils";
import { rule } from "./no-nested-steps";

const ruleTester = new ESLintUtils.RuleTester({
  parser: "@typescript-eslint/parser",
});

const messageId = "no-nested-steps";

ruleTester.run("no-nested-steps", rule, {
  valid: [
    `inngest.createFunction({ name: "" }, { event: "" }, async ({ step }) => {
      await step.run("A", () => "A");
      await step.sleep("5s");
      await step.run("B", () => "B");
    });`,
  ],
  invalid: [
    {
      code: `inngest.createFunction({ name: "" }, { event: "" }, async ({ step }) => {
        await step.run("A", async () => {
          await step.sleep("5s");
        });

        await step.run("B", () => "B");
      });`,
      errors: [{ line: 3, messageId }],
    },
  ],
});
