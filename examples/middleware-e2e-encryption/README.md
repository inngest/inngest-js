# E2E Encryption

We can use middleware to encrypt data before it's shipped to Inngest and decrypt it as it comes back in to functions.

In [`stepEncryptionMiddleware.ts`](./stepEncryptionMiddleware.ts), we provide an example of encrypting and decrypting all step state as it is passed to and from Inngest. This example's "encryption" is just stringifying and reversing the value - in practice you'll want to replace this with your own method using something like [`node:crypto`](https://nodejs.org/api/crypto.html).

> [!WARNING]
> If you encrypt your step data and lose your encryption key, you'll lose access to all encrypted state. Be careful! In addition, seeing step results in the Inngest dashboard will no longer be possible.

```ts
const inngest = new Inngest({
  id: "my-app",
  middleware: [stepEncryptionMiddleware()],
});

inngest.createFunction(
  { id: "example-function", triggers: [{ event: "app/user.created" }] },
  async ({ event, step }) => {
    /**
     * The return value of `db.get()` - and therefore the value of `user` is now
     * silently encrypted and decrypted by the middleware; no plain-text step
     * data leaves your server or is stored in Inngest Cloud.
     */
    const user = await step.run("get-user", () =>
      db.get("user", event.data.userId)
    );
  }
);
```

It's also easily possible to also encrypt all event data, too, with [`fullEncryptionMiddleware.ts`](./fullEncryptionMiddlware.ts).

> [!WARNING]
> Encrypting event data means that using features of Inngest such as `step.waitForEvent()` with expressions and browsing event data in the dashboard are no longer possible.

Be aware that, unlike step data, event data is much more commonly shared between systems; think about if you need to also encrypt your event data before doing so.
