import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";

export const noAwaitOutsideSteps: TSESLint.RuleModule<"no-await-outside-steps"> =
  {
    meta: {
      type: "problem",
      docs: {
        description:
          "disallow use of `await` outside of `step.run()` callbacks in Inngest functions",
        recommended: "recommended",
      },
      schema: [], // no options
      messages: {
        "no-await-outside-steps":
          "Use of `await` is only allowed within step function callbacks in Inngest functions",
      },
    },
    defaultOptions: [],
    create(context: TSESLint.RuleContext<"no-await-outside-steps", []>) {
      // Track function scopes with minimal data that won't create circular references
      const functionScopes = new Map<
        string,
        { isInngestHandler: boolean; stepRunStack: number }
      >();

      // Generate a unique key for a function node
      function getFunctionKey(node: TSESTree.FunctionLike): string {
        // Use node.range if available, otherwise create a key from the node's start/end location
        if (node.range) {
          return `${node.range[0]}-${node.range[1]}`;
        }
        const loc = node.loc;
        return loc
          ? `${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}`
          : "unknown";
      }

      // Find parent function without storing node references
      function findParentFunction(
        node: TSESTree.Node,
      ): { key: string; node: TSESTree.FunctionLike } | null {
        let current = node.parent;
        while (current) {
          if (
            current.type === AST_NODE_TYPES.FunctionDeclaration ||
            current.type === AST_NODE_TYPES.FunctionExpression ||
            current.type === AST_NODE_TYPES.ArrowFunctionExpression
          ) {
            return {
              key: getFunctionKey(current),
              node: current,
            };
          }
          current = current.parent;
        }
        return null;
      }

      // Check if node is a step function call (step.run, step.waitFor, etc)
      function isStepFunctionCall(node: TSESTree.Node): boolean {
        return (
          node.type === AST_NODE_TYPES.CallExpression &&
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          node.callee.object.type === AST_NODE_TYPES.Identifier &&
          node.callee.object.name === "step" &&
          node.callee.property.type === AST_NODE_TYPES.Identifier &&
          [
            "run",
            "sleep",
            "sleepUntil",
            "invoke",
            "waitForEvent",
            "sendEvent",
          ].includes(node.callee.property.name)
        );
      }

      return {
        // Identify potential Inngest handler functions
        "FunctionDeclaration, FunctionExpression, ArrowFunctionExpression"(
          node:
            | TSESTree.FunctionDeclaration
            | TSESTree.FunctionExpression
            | TSESTree.ArrowFunctionExpression,
        ) {
          // Check if function has a parameter named 'step' or has destructuring that includes 'step'
          const hasStepParam = node.params.some((param) => {
            if (param.type === AST_NODE_TYPES.Identifier) {
              return param.name === "step";
            } else if (param.type === AST_NODE_TYPES.ObjectPattern) {
              return param.properties.some(
                (prop) =>
                  prop.type === AST_NODE_TYPES.Property &&
                  prop.key.type === AST_NODE_TYPES.Identifier &&
                  prop.key.name === "step",
              );
            }
            return false;
          });

          const isInngestHandler = hasStepParam && node.async;
          functionScopes.set(getFunctionKey(node), {
            isInngestHandler,
            stepRunStack: 0,
          });
        },

        // Track step function calls
        CallExpression(node) {
          if (isStepFunctionCall(node)) {
            const parentFunc = findParentFunction(node);
            if (parentFunc) {
              const scopeInfo = functionScopes.get(parentFunc.key);
              if (scopeInfo) {
                scopeInfo.stepRunStack += 1;
                functionScopes.set(parentFunc.key, scopeInfo);
              }
            }
          }
        },

        "CallExpression:exit"(node) {
          if (isStepFunctionCall(node)) {
            const parentFunc = findParentFunction(node);
            if (parentFunc) {
              const scopeInfo = functionScopes.get(parentFunc.key);
              if (scopeInfo) {
                scopeInfo.stepRunStack = Math.max(
                  0,
                  scopeInfo.stepRunStack - 1,
                );
                functionScopes.set(parentFunc.key, scopeInfo);
              }
            }
          }
        },

        // Check await expressions
        AwaitExpression(node) {
          // Allow await if it's directly awaiting a step function call
          if (isStepFunctionCall(node.argument)) {
            return;
          }

          const parentFunc = findParentFunction(node);
          if (parentFunc) {
            const scopeInfo = functionScopes.get(parentFunc.key);
            if (
              scopeInfo &&
              scopeInfo.isInngestHandler &&
              scopeInfo.stepRunStack === 0
            ) {
              context.report({
                node,
                messageId: "no-await-outside-steps",
              });
            }
          }
        },

        // Clean up function scopes
        "Program:exit"() {
          functionScopes.clear();
        },
      };
    },
  };
