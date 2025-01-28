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
  addSignalListener: (signal: string, fn: () => void) => void;
  removeSignalListener: (signal: string, fn: () => void) => void;
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

export function onShutdown(fn: () => void) {
  // Deno
  try {
    if (Deno) {
      Deno.addSignalListener("SIGINT", fn);
      Deno.addSignalListener("SIGTERM", fn);
      return () => {
        Deno.removeSignalListener("SIGINT", fn);
        Deno.removeSignalListener("SIGTERM", fn);
      };
    }
  } catch (err) {
    // no-op
  }

  // Node, Bun
  try {
    if (process) {
      // eslint-disable-next-line @inngest/internal/process-warn
      process.on("SIGINT", fn);
      // eslint-disable-next-line @inngest/internal/process-warn
      process.on("SIGTERM", fn);
      return () => {
        // eslint-disable-next-line @inngest/internal/process-warn
        process.removeListener("SIGINT", fn);
        // eslint-disable-next-line @inngest/internal/process-warn
        process.removeListener("SIGTERM", fn);
      };
    }
  } catch (err) {
    // no-op
  }

  return () => {};
}
