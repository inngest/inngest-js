module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow use of any `step.*` within a `step.run()` function",
      category: "Possible Errors",
      recommended: true,
    },
    schema: [], // no options
  },
  create(context) {
    let stepRunDepth = 0;

    return {
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.name === "step"
        ) {
          if (node.callee.property.name === "run") {
            stepRunDepth += 1;
          }

          if (stepRunDepth > 1) {
            context.report({
              node,
              message:
                "Use of `step.*` within a `step.run()` function is not allowed",
            });
          }
        }
      },
      "CallExpression:exit"(node) {
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.name === "step" &&
          node.callee.property.name === "run"
        ) {
          stepRunDepth -= 1;
        }
      },
    };
  },
};
