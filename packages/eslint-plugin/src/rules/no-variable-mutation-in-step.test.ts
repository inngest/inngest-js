import { RuleTester } from "@typescript-eslint/rule-tester";
import { noVariableMutationInStep } from "./no-variable-mutation-in-step";

const ruleTester = new RuleTester({
  parser: "@typescript-eslint/parser",
});

ruleTester.run("my-rule", noVariableMutationInStep, {
  valid: [
    `let a = 1;
    a = await step.run("add-one", () => a + 1);`,
  ],
  invalid: [
    {
      name: "Returning UpdateExpression",
      code: `let a = 1;
          await step.run("add-one", () => a++);`,
      errors: [{ messageId: "no-variable-mutation-in-step" }],
    },
    {
      name: "UpdateExpression ++",
      code: `let a = 1;
          await step.run("add-one", () => {
               a++;
          });`,
      errors: [{ messageId: "no-variable-mutation-in-step" }],
    },
    {
      name: "AssignmentExpression +=",
      code: `let a = 1;
         await step.run("add-one", () => {
               a += 1;
         });`,
      errors: [{ messageId: "no-variable-mutation-in-step" }],
    },
    {
      name: "AssignmentExpression +",
      code: `let a = 1;
        await step.run("add-one", () => {
               a = a + 1;
        });`,
      errors: [{ messageId: "no-variable-mutation-in-step" }],
    },
  ],
});
