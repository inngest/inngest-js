import { AST_NODE_TYPES, TSESLint } from "@typescript-eslint/utils";

export const noVariableMutationInStep: TSESLint.RuleModule<"no-variable-mutation-in-step"> =
  {
    meta: {
      type: "problem",
      docs: {
        description: "disallow mutating variables inside `step.run()`",
        recommended: "recommended",
      },
      schema: [], // no options
      messages: {
        "no-variable-mutation-in-step":
          "Do not mutate variables inside `step.run()`, return the result instead",
      },
    },
    defaultOptions: [],
    create(context) {
      let inStepRun = false;
      const declaredVariables = new Set();

      return {
        VariableDeclaration(node) {
          if (!inStepRun) {
            node.declarations.forEach((declaration) => {
              if (declaration.id.type === AST_NODE_TYPES.Identifier) {
                declaredVariables.add(declaration.id.name);
              }
            });
          }
        },
        AssignmentExpression(node) {
          if (
            inStepRun &&
            node.left.type === AST_NODE_TYPES.Identifier &&
            declaredVariables.has(node.left.name)
          ) {
            context.report({
              node,
              messageId: "no-variable-mutation-in-step",
            });
          }
        },
        CallExpression(node) {
          if (
            node.callee.type === AST_NODE_TYPES.MemberExpression &&
            node.callee.object.type === AST_NODE_TYPES.Identifier &&
            node.callee.object.name === "step" &&
            node.callee.property.type === AST_NODE_TYPES.Identifier &&
            node.callee.property.name === "run"
          ) {
            inStepRun = true;
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
            inStepRun = false;
          }
        },
      };
    },
  };
