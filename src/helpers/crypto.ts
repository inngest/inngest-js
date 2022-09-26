import cryptoIsomorphic from "isomorphic-crypto";
import type { createHash as createHashT } from "crypto";

// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
export const createHash = cryptoIsomorphic.createHash as typeof createHashT;
