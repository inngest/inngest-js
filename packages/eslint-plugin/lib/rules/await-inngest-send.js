// Thanks, Max from https://gowindmill.com/
module.exports = {
  meta: {
    type: "suggestion",
    docs: {
      description: "enforce `await` or `return` before `inngest.send()`",
      category: "Best Practices",
      recommended: true,
    },
    schema: [], // no options
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.name === "inngest" &&
          node.callee.property.name === "send"
        ) {
          const parent = node.parent;
          if (
            parent.type !== "AwaitExpression" &&
            parent.type !== "ReturnStatement"
          ) {
            context.report({
              node,
              message:
                "You should use `await` or `return` before `inngest.send()`",
            });
          }
        }
      },
    };
  },
};
