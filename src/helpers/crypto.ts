/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import cryptoIsomorphic from "isomorphic-crypto";
import type { createHash as createHashT } from "crypto";

if (typeof global !== "undefined") {
  global.crypto = cryptoIsomorphic;
} else {
  (global as any) = { crypto: cryptoIsomorphic };
}

if (typeof window !== "undefined") {
  window.crypto = cryptoIsomorphic;
}

/* eslint-disable @typescript-eslint/no-unsafe-member-access */
export const createHash = cryptoIsomorphic.createHash as typeof createHashT;
