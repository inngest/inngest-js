import { AST_NODE_TYPES, TSESLint } from "@typescript-eslint/utils";

export const deterministicSleepUntilDates: TSESLint.RuleModule<"deterministic-sleep-until-dates"> =
  {
    meta: {
      type: "suggestion",
      docs: {
        description: "enforce static dates for `step.sleepUntil()`",
        recommended: "recommended",
      },
      schema: [], // no options
      messages: {
        "deterministic-sleep-until-dates":
          "Use a static date for `step.sleepUntil()`, not a dynamic one",
      },
    },
    defaultOptions: [],
    create(context) {
      return {
        CallExpression(node) {
          if (
            node.callee.type === AST_NODE_TYPES.MemberExpression &&
            node.callee.object.type === AST_NODE_TYPES.Identifier &&
            node.callee.object.name === "step" &&
            node.callee.property.type === AST_NODE_TYPES.Identifier &&
            node.callee.property.name === "sleepUntil"
          ) {
            const dateArgument = node.arguments[1];

            if (
              dateArgument.type === AST_NODE_TYPES.NewExpression ||
              (dateArgument.type === AST_NODE_TYPES.CallExpression &&
                dateArgument.callee.type === AST_NODE_TYPES.MemberExpression &&
                dateArgument.callee.object.type === AST_NODE_TYPES.Identifier &&
                dateArgument.callee.object.name === "Date")
            ) {
              context.report({
                node,
                messageId: "deterministic-sleep-until-dates",
              });
            }
          }
        },
      };
    },
  };
