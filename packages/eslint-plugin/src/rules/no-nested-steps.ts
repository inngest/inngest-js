import { AST_NODE_TYPES, TSESLint } from "@typescript-eslint/utils";

export const noNestedSteps: TSESLint.RuleModule<"no-nested-steps"> = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow use of any `step.*` within another `step.*` function",
      recommended: "recommended",
    },
    schema: [], // no options
    messages: {
      "no-nested-steps":
        "Use of `step.*` within another `step.*` function is not allowed",
    },
  },
  defaultOptions: [],
  create(context: TSESLint.RuleContext<"no-nested-steps", []>) {
    let stepDepth = 0;

    return {
      CallExpression(node: TSESLint.TSESTree.CallExpression) {
        if (
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          node.callee.object.type === AST_NODE_TYPES.Identifier &&
          node.callee.object.name === "step"
        ) {
          if (stepDepth > 0) {
            context.report({
              node,
              messageId: "no-nested-steps",
            });
          }
          stepDepth++;
        }
      },
      "CallExpression:exit"(node: TSESLint.TSESTree.CallExpression) {
        if (
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          node.callee.object.type === AST_NODE_TYPES.Identifier &&
          node.callee.object.name === "step"
        ) {
          stepDepth--;
        }
      },
    };
  },
};
