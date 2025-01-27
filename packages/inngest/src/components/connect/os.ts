export async function retrieveSystemAttributes() {
  return {
    cpuCores: await retrieveCpuCores(),
    memBytes: await retrieveMemBytes(),
    os: await retrieveOs(),
  };
}

/**
 * The Deno environment, which is not always available.
 */
declare const Deno: {
  systemMemoryInfo: () => {
    total: number;
  };
};

async function retrieveCpuCores() {
  // Works for Deno, Node, Bun
  try {
    const os = await import("node:os");
    return os.cpus().length;
  } catch (err) {
    // no-op
  }

  // Browser
  try {
    if (navigator && navigator.hardwareConcurrency) {
      return navigator.hardwareConcurrency;
    }
  } catch (err) {
    // no-op
  }

  return 0;
}

async function retrieveMemBytes() {
  // Deno
  try {
    if (Deno) {
      return Deno.systemMemoryInfo().total;
    }
  } catch (err) {
    // no-op
  }

  // Node, Bun
  try {
    const os = await import("node:os");
    return os.totalmem();
  } catch (err) {
    // no-op
  }

  return 0;
}

async function retrieveOs() {
  // Deno, Node, Bun
  try {
    const os = await import("node:os");
    return os.platform();
  } catch (err) {
    // no-op
  }

  // Browser
  try {
    if (navigator && navigator.platform) {
      return navigator.platform;
    }
  } catch (err) {
    // no-op
  }

  return "unknown";
}
