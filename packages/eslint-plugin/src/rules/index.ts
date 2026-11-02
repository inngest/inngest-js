import { TSESLint } from "@typescript-eslint/utils";
import { awaitInngestSend } from "./await-inngest-send";
import { noNestedSteps } from "./no-nested-steps";
import { noVariableMutationInStep } from "./no-variable-mutation-in-step";
import { noAwaitOutsideSteps } from "./no-await-outside-step";

export const rules = {
  "await-inngest-send": awaitInngestSend,
  "no-nested-steps": noNestedSteps,
  "no-variable-mutation-in-step": noVariableMutationInStep,
  "no-await-outside-steps": noAwaitOutsideSteps,
} satisfies Record<string, TSESLint.RuleModule<string, Array<unknown>>>;
