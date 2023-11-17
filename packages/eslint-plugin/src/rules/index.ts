import { TSESLint } from "@typescript-eslint/utils";
import { awaitInngestSend } from "./await-inngest-send";
import { deterministicSleepUntilDates } from "./deterministic-sleep-until-dates";
import { noNestedSteps } from "./no-nested-steps";
import { noVariableMutationInStep } from "./no-variable-mutation-in-step";

export const rules = {
  "await-inngest-send": awaitInngestSend,
  "deterministic-sleep-until-dates": deterministicSleepUntilDates,
  "no-nested-steps": noNestedSteps,
  "no-variable-mutation-in-step": noVariableMutationInStep,
} satisfies Record<string, TSESLint.RuleModule<string, Array<unknown>>>;
