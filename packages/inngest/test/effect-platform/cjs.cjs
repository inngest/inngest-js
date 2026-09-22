// node test/effect-platform/cjs.cjs (after building)
// Resolve package exports from the built package's own scope, not the source
// workspace manifest. This exercises the published self-reference boundary.
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const path = require("node:path");
const fromDist = createRequire(
  path.resolve(__dirname, "../../dist/package.json"),
);
const { Inngest } = fromDist("inngest");
assert.equal(typeof Inngest, "function");
assert.equal(
  new Inngest({ id: "effect-platform-cjs" }).id,
  "effect-platform-cjs",
);
assert.throws(() => fromDist("inngest/effect"), {
  code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
});
console.log(
  "Default built CommonJS export works; inngest/effect is intentionally ESM-only.",
);
