import { InngestMiddleware, type MiddlewareOptions } from "inngest";
import {
  type EncryptionMiddlewareOptions,
  getEncryptionStages,
} from "./stages";

/**
 * Encrypts and decrypts data sent to and from Inngest.
 *
 * Returns two separate middlewares: one for encrypting data, and one for
 * decrypting data, used in special circumstances pre-v4.
 */
export const manualEncryptionMiddleware = (
  /**
   * Options used to configure the encryption middleware. If a custom
   * `encryptionService` is not provided, the `key` option is required.
   */
  opts: EncryptionMiddlewareOptions
): {
  encryptionMiddleware: InngestMiddleware<MiddlewareOptions>;
  decryptionMiddleware: InngestMiddleware<MiddlewareOptions>;
} => {
  const { encrypt, decrypt } = getEncryptionStages(opts);

  return {
    encryptionMiddleware: new InngestMiddleware({
      name: "@inngest/middleware-encryption/manual/encrypt",
      init: () => encrypt,
    }),

    decryptionMiddleware: new InngestMiddleware({
      name: "@inngest/middleware-encryption/manual/decrypt",
      init: () => decrypt,
    }),
  };
};
