module.exports = {
  meta: {
    type: "suggestion",
    docs: {
      description: "enforce static dates for `step.sleepUntil()`",
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
          node.callee.object.name === "step" &&
          node.callee.property.name === "sleepUntil"
        ) {
          const dateArgument = node.arguments[1];

          if (
            dateArgument.type === "NewExpression" ||
            (dateArgument.type === "CallExpression" &&
              dateArgument.callee.object.name === "Date")
          ) {
            context.report({
              node,
              message:
                "Use a static date for `step.sleepUntil()`, not a dynamic one",
            });
          }
        }
      },
    };
  },
};
