module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "disallow mutating variables inside `step.run()`",
      category: "Possible Errors",
      recommended: true,
    },
    schema: [], // no options
  },
  create(context) {
    let inStepRun = false;
    const declaredVariables = new Set();

    return {
      VariableDeclaration(node) {
        if (!inStepRun) {
          node.declarations.forEach((declaration) => {
            declaredVariables.add(declaration.id.name);
          });
        }
      },
      AssignmentExpression(node) {
        if (inStepRun && declaredVariables.has(node.left.name)) {
          context.report({
            node,
            message:
              "Do not mutate variables inside `step.run()`, return the result instead",
          });
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.name === "step" &&
          node.callee.property.name === "run"
        ) {
          inStepRun = true;
        }
      },
      "CallExpression:exit"(node) {
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.name === "step" &&
          node.callee.property.name === "run"
        ) {
          inStepRun = false;
        }
      },
    };
  },
};
