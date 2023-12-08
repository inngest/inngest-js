# @inngest/middleware-encryption

This package provides an encryption middleware for Inngest, enabling secure handling of sensitive data. It encrypts data being sent to and from Inngest, ensuring plaintext data never leaves your server.

## Features
- **Data Encryption:** Encrypts step and event data, with support for multiple encryption keys.
- **Customizable Encryption Service:** Allows use of a custom encryption service or the default AES-based service.
- **Event Data Encryption Option:** Option to encrypt events sent to Inngest, though this may impact certain Inngest dashboard features.

## Installation

```sh
npm install @inngest/middleware-encryption
```

> [!NOTE]
> Requires TypeScript SDK v3+

## Usage

To use the encryption middleware, import and initialize it with your encryption key(s). You can optionally provide a custom encryption service.

```ts
import { encryptionMiddleware } from "@inngest/middleware-encryption";

// Initialize the middleware
const mw = encryptionMiddleware({
  key: "your-encryption-key",
});

// Use the middleware with Inngest
const inngest = new Inngest({
  id: "my-app",
  middleware: [mw],
});
```

## Implementing your own encryption

To create a custom encryption service, you need to implement the abstract `EncryptionService` class provided by the package. Your custom service must implement two core methods: `encrypt` and `decrypt`.

```ts
export abstract class EncryptionService {
  public abstract encrypt(value: unknown): string;
  public abstract decrypt(value: string): unknown;
}
```

For example, here's how you might define, instantiate, and use a custom encryption service:

```ts
import { EncryptionService } from "@inngest/middleware-encryption";

class CustomEncryptionService implements EncryptionService {
  constructor(/* custom parameters */) {
    // Initialization code here
  }

  encrypt(value: unknown): string {
    // Implement your custom encryption logic here
    // Example: return CustomEncryptLib.encrypt(JSON.stringify(value), this.customKey);
  }

  decrypt(value: string): unknown {
    // Implement your custom decryption logic here
    // Example: return JSON.parse(CustomEncryptLib.decrypt(value, this.customKey));
  }
}
```

You can then pass it to the `encryptionMiddleware` function like so:

```ts
const customService = new CustomEncryptionService(/* custom parameters */);

const mw = encryptionMiddleware({
  encryptionService: customService,
});

// Use the middleware with Inngest
const inngest = new Inngest({
  id: "my-app",
  middleware: [mw],
});
```
