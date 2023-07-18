/**
 * Adapted from `eslint-plugin-node`'s `no-process-env` rule.
 *
 * {@link https://github.com/mysticatea/eslint-plugin-node/blob/master/lib/rules/no-process-env.js}
 */
"use strict";

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

module.exports = {
  meta: {
    type: "suggestion",
    docs: {
      description: "warn on use of `process.env`",
    },
    fixable: null,
    schema: [],
    messages: {
      dangerousProcessUsage:
        "Ensure process is only used in non-shared locations",
    },
  },

  create(context) {
    return {
      MemberExpression(node) {
        const objectName = node.object.name;

        if (objectName === "process" && !node.computed) {
          context.report({ node, messageId: "dangerousProcessUsage" });
        }
      },
    };
  },
};
