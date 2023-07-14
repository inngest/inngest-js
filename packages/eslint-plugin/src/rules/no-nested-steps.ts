import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { RuleModule } from "@typescript-eslint/utils/dist/ts-eslint";
import { hasParent } from "../utils/hasParent";

const isStepCall = (node: TSESTree.Node): boolean => {
  return (
    node.type === AST_NODE_TYPES.CallExpression &&
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.object.type === AST_NODE_TYPES.Identifier &&
    node.callee.object.name === "step" &&
    node.callee.property.type === AST_NODE_TYPES.Identifier
  );
};

const isInngestCreateFunction = (node: TSESTree.Node): boolean => {
  return (
    node.type === AST_NODE_TYPES.CallExpression &&
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.object.type === AST_NODE_TYPES.Identifier &&
    node.callee.object.name === "inngest" &&
    node.callee.property.type === AST_NODE_TYPES.Identifier &&
    node.callee.property.name === "createFunction"
  );
};

export const rule = {
  meta: {
    type: "problem",
    messages: {
      "no-nested-steps": "No nested steps",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        if (
          isStepCall(node) &&
          hasParent(node, isStepCall) &&
          hasParent(node, isInngestCreateFunction)
        ) {
          context.report({
            node,
            messageId: "no-nested-steps",
          });
        }
      },
    };
  },
} satisfies RuleModule<string>;
