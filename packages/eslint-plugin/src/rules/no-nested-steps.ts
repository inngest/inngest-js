import { AST_NODE_TYPES, TSESLint } from "@typescript-eslint/utils";

export const noNestedSteps: TSESLint.RuleModule<"no-nested-steps"> = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow use of any `step.*` within a `step.run()` function",
      recommended: "recommended",
    },
    schema: [], // no options
    messages: {
      "no-nested-steps":
        "Use of `step.*` within a `step.run()` function is not allowed",
    },
  },
  defaultOptions: [],
  create(context) {
    let stepRunDepth = 0;

    return {
      CallExpression(node) {
        if (
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          node.callee.object.type === AST_NODE_TYPES.Identifier &&
          node.callee.object.name === "step"
        ) {
          if (
            node.callee.property.type === AST_NODE_TYPES.Identifier &&
            node.callee.property.name === "run"
          ) {
            stepRunDepth += 1;
          }

          if (stepRunDepth > 1) {
            context.report({
              node,
              messageId: "no-nested-steps",
            });
          }
        }
      },
      "CallExpression:exit"(node) {
        if (
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          node.callee.object.type === AST_NODE_TYPES.Identifier &&
          node.callee.object.name === "step" &&
          node.callee.property.type === AST_NODE_TYPES.Identifier &&
          node.callee.property.name === "run"
        ) {
          stepRunDepth -= 1;
        }
      },
    };
  },
};
