module.exports = {
  rules: {
    "no-variable-mutation-in-step": require("./rules/no-variable-mutation-in-step"),
    "deterministic-sleep-until-dates": require("./rules/deterministic-sleep-until-dates"),
    "no-nested-steps": require("./rules/no-nested-steps"),
    "await-inngest-send": require("./rules/await-inngest-send"),
  },
};
