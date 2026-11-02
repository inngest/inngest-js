/**
 * @module
 * The network guard for `tool.mcp()`. Every URL the MCP code reaches (the
 * server and the OAuth endpoints it names) goes through `assertMcpUrl()`:
 * https only, no private or internal addresses, and no credentials in the
 * URL. `http:` is allowed for localhost only, for tests and the Dev Server.
 *
 * Redirects are refused where the requests are made (`redirect: "error"`).
 *
 * The check reads the URL, not DNS: a public name that resolves to a private
 * address is not caught here.
 */
import { SandboxValidationError } from "./types.ts";

const loopbackNames = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Hosts that are only reachable from inside a network.
const internalSuffixes = [".internal", ".local", ".localhost", ".lan", ".home"];

const ipv4Of = (host: string): number[] | undefined => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);

  if (!match) {
    return undefined;
  }

  return match.slice(1).map(Number);
};

const isPrivateIpv4 = ([a, b]: number[]): boolean => {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && (b ?? 0) >= 64 && (b ?? 0) <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && (b ?? 0) >= 16 && (b ?? 0) <= 31) ||
    (a === 192 && b === 168) ||
    (a ?? 0) >= 224
  );
};

// Eight 16-bit groups from the text of an IPv6 address, or undefined.
const ipv6Groups = (host: string): number[] | undefined => {
  const text = host.slice(1, -1).toLowerCase();
  const halves = text.split("::");

  if (halves.length > 2) {
    return undefined;
  }

  const parse = (part: string): number[] | undefined => {
    if (part === "") {
      return [];
    }

    const groups: number[] = [];

    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return undefined;
      }

      groups.push(Number.parseInt(group, 16));
    }

    return groups;
  };
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];

  if (!head || !tail) {
    return undefined;
  }

  if (halves.length === 1) {
    return head.length === 8 ? head : undefined;
  }

  const missing = 8 - head.length - tail.length;

  return missing < 1
    ? undefined
    : [...head, ...Array(missing).fill(0), ...tail];
};

const isPrivateIpv6 = (host: string): boolean => {
  const groups = ipv6Groups(host);

  if (!groups) {
    // Not an address we can read: do not guess.
    return true;
  }

  const [first = 0] = groups;
  const embedded =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
      ? ([groups[6] ?? 0, groups[7] ?? 0] as const)
      : undefined;

  if (embedded) {
    const [high, low] = embedded;

    return isPrivateIpv4([high >> 8, high & 255, low >> 8, low & 255]);
  }

  const unspecifiedOrLoopback =
    groups.slice(0, 7).every((group) => group === 0) && (groups[7] ?? 0) <= 1;

  return (
    unspecifiedOrLoopback ||
    (first & 0xfe00) === 0xfc00 || // fc00::/7, unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10, link local
    (first & 0xff00) === 0xff00 // ff00::/8, multicast
  );
};

// The limit: this reads the URL and does not resolve DNS, so a public name that
// resolves to a private address is not caught here.
const isPrivateHost = (hostname: string): boolean => {
  if (hostname.startsWith("[")) {
    return isPrivateIpv6(hostname);
  }

  const v4 = ipv4Of(hostname);

  if (v4) {
    return isPrivateIpv4(v4);
  }

  // A name with no dot is a name on someone's network.
  return (
    !hostname.includes(".") ||
    internalSuffixes.some((suffix) => hostname.endsWith(suffix))
  );
};

// A loopback host written the plain way. `new URL()` turns `2130706433` and
// `0x7f.1` into `127.0.0.1`; those are refused because they were not written
// as loopback.
const isPlainLoopback = (raw: string, hostname: string): boolean => {
  if (!loopbackNames.has(hostname)) {
    return false;
  }

  return new RegExp(
    `^https?://${hostname.replace(/[[\].]/g, "\\$&")}(?:[:/?#]|$)`,
    "i",
  ).test(raw.trim());
};

/**
 * Throws a `SandboxValidationError` unless `value` is a URL `tool.mcp()` may
 * reach. `what` names the URL in the message.
 */
export const assertMcpUrl = (value: string, what: string): URL => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new SandboxValidationError(
      `tool.mcp() needs a full url: "${value}" is not one`,
    );
  }

  const loopback = isPlainLoopback(value, url.hostname);

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new SandboxValidationError(
      `tool.mcp() ${what} must be https (http is only allowed for localhost): ${url.origin}`,
    );
  }

  if (url.username || url.password) {
    throw new SandboxValidationError(
      `tool.mcp() ${what} must not hold credentials: use auth`,
    );
  }

  if (!loopback && isPrivateHost(url.hostname)) {
    throw new SandboxValidationError(
      `tool.mcp() ${what} points at a private or internal address: ${url.origin}`,
    );
  }

  return url;
};
