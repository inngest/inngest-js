/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
export const sha256Hash =
  typeof crypto === "undefined"
    ? /**
       * Node land - use `crypto` via an import
       */
      async (data: string): Promise<string> => {
        return require("crypto")
          .createHash("sha256")
          .update(data)
          .digest("hex");
      }
    : /**
       * Browser/SW land - use web APIs
       */
      async (data: string): Promise<string> => {
        return Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(data)
            )
          )
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      };
