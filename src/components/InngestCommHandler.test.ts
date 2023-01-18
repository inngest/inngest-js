import { InngestCommHandler } from "./InngestCommHandler";

describe("validateSignature", () => {
  const ch = new InngestCommHandler("test", "appname", [], undefined, null as any, () => {});

  ch["signingKey"] = "signkey-test-f00f3005a3666b359a79c2bc3380ce2715e62727ac461ae1a2618f8766029c9f";

  test("should throw an error with an invalid signature", () => {
    const sig = "t=1674082860&s=88b6453463050d1846743cbba0925bae7c1cf807f9c74bbd41b3d5cfc9c70d11"
    const body = {"ctx":{"fn_id":"function name changed","run_id":"01GQ3HTEZ01M7R8Z9PR1DMHDN1","step_id":"step"},"event":{"data":{},"id":"","name":"inngest/scheduled.timer","ts":1674082830001,"user":{},"v":"1"},"steps":{}};

    expect(() => { ch['validateSignature'](sig, body); }).toThrowError();
  });

  test("should throw an error with expired signatures", () => {
    // These signatures are randomly generated within a local development environment, matching
    // what is sent from the cloud.
    // 
    // This prevents us from having to rewrite the signature creation function in JS, which may
    // differ from the cloud/CLI version.
    const sig = "t=1674082860&s=88b6453463050d1846743cbba0925bae7c1cf807f9c74bbd41b3d5cfc9c70d11"
    const body = {"ctx":{"fn_id":"local-testing-local-cron","run_id":"01GQ3HTEZ01M7R8Z9PR1DMHDN1","step_id":"step"},"event":{"data":{},"id":"","name":"inngest/scheduled.timer","ts":1674082830001,"user":{},"v":"1"},"steps":{}};

    expect(() => { ch['validateSignature'](sig, body); }).toThrowError("Request has expired");
  });

  test("should validate a signature with a key successfully", () => {
    // These signatures are randomly generated within a local development environment, matching
    // what is sent from the cloud.
    // 
    // This prevents us from having to rewrite the signature creation function in JS, which may
    // differ from the cloud/CLI version.
    const sig = "t=1674082860&s=88b6453463050d1846743cbba0925bae7c1cf807f9c74bbd41b3d5cfc9c70d11"
    const body = {"ctx":{"fn_id":"local-testing-local-cron","run_id":"01GQ3HTEZ01M7R8Z9PR1DMHDN1","step_id":"step"},"event":{"data":{},"id":"","name":"inngest/scheduled.timer","ts":1674082830001,"user":{},"v":"1"},"steps":{}};

    // Allow expired signatures for this test.
    ch["allowExpiredSignatures"] = true

    expect(() => { ch['validateSignature'](sig, body); }).not.toThrowError("Invalid signature");
  });
});
