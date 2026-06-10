let setupLock = Promise.resolve();

/**
 * Run global OTel provider setup one-at-a-time across SDK features. OTel
 * provider registration is process-global, so concurrent setup attempts must
 * not race.
 */
export async function withOTelLock<T>(setup: () => Promise<T>): Promise<T> {
  const previousSetup = setupLock;
  let releaseSetupLock = noop;

  setupLock = new Promise<void>(function (resolve) {
    releaseSetupLock = resolve;
  });

  await previousSetup;

  try {
    return await setup();
  } finally {
    releaseSetupLock();
  }
}

function noop(): void {}
