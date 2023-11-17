import { AST_NODE_TYPES, TSESLint } from "@typescript-eslint/utils";

// Thanks, Max from https://gowindmill.com/
export const awaitInngestSend: TSESLint.RuleModule<"await-inngest-send"> = {
  meta: {
    type: "suggestion",
    docs: {
      description: "enforce `await` or `return` before `inngest.send()`",
      recommended: "recommended",
    },
    schema: [], // no options
    messages: {
      "await-inngest-send":
        "You should use `await` or `return` before `inngest.send()",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          node.callee.object.type === AST_NODE_TYPES.Identifier &&
          node.callee.object.name === "inngest" &&
          node.callee.property.type === AST_NODE_TYPES.Identifier &&
          node.callee.property.name === "send"
        ) {
          const parent = node.parent;
          if (
            parent.type !== AST_NODE_TYPES.AwaitExpression &&
            parent.type !== AST_NODE_TYPES.ReturnStatement
          ) {
            context.report({
              node,
              messageId: "await-inngest-send",
            });
          }
        }
      },
    };
  },
};
