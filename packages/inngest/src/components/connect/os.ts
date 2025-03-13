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
  hostname: () => string;
};

async function retrieveCpuCores() {
  // Works for Deno, Node, Bun
  try {
    const os = await import("node:os");
    return os.cpus().length;
  } catch (_err) {
    // no-op
  }

  // Browser
  try {
    if (navigator && navigator.hardwareConcurrency) {
      return navigator.hardwareConcurrency;
    }
  } catch (_err) {
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
  } catch (_err) {
    // no-op
  }

  // Node, Bun
  try {
    const os = await import("node:os");
    return os.totalmem();
  } catch (_err) {
    // no-op
  }

  return 0;
}

async function retrieveOs() {
  // Deno, Node, Bun
  try {
    const os = await import("node:os");
    return os.platform();
  } catch (_err) {
    // no-op
  }

  // Browser
  try {
    if (navigator && navigator.platform) {
      return navigator.platform;
    }
  } catch (_err) {
    // no-op
  }

  return "unknown";
}

export function onShutdown(signals: string[], fn: () => void) {
  // Deno
  try {
    if (Deno) {
      // biome-ignore lint/complexity/noForEach: <explanation>
      signals.forEach((signal) => {
        Deno.addSignalListener(signal, fn);
      });
      return () => {
        // biome-ignore lint/complexity/noForEach: <explanation>
        signals.forEach((signal) => {
          Deno.removeSignalListener(signal, fn);
        });
      };
    }
  } catch (_err) {
    // no-op
  }

  // Node, Bun
  try {
    if (process) {
      // biome-ignore lint/complexity/noForEach: <explanation>
      signals.forEach((signal) => {
        process.on(signal, fn);
      });
      return () => {
        // biome-ignore lint/complexity/noForEach: <explanation>
        signals.forEach((signal) => {
          process.removeListener(signal, fn);
        });
      };
    }
  } catch (_err) {
    // no-op
  }

  return () => {};
}

export async function getHostname() {
  // Deno
  try {
    if (Deno) {
      return Deno.hostname();
    }
  } catch (_err) {
    // no-op
  }

  // Node, Bun
  try {
    const os = await import("node:os");
    return os.hostname();
  } catch (_err) {
    // no-op
  }

  return "unknown";
}
