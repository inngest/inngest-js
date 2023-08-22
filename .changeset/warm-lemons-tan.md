---
"inngest": minor
---

Add the ability to provide Zod schemas using `z.object()` instead of requiring a record format

```ts
// Previously we supported this
new EventSchemas().fromZod({
  "test.event": {
    data: z.object({ a: z.string() }),
    user: z.object({ b: z.number() }),
  },
});

// Now we ALSO support this
new EventSchemas().fromZod([
  z.object({
    name: z.literal("test.event"),
    data: z.object({ a: z.string() }),
    user: z.object({ b: z.number() }),
  }),
]);
```

This should help if you wish to declare your events piece-by-piece instead of in a single object.

```ts
const firstEvent = z.object({
  name: z.literal("app/user.created"),
  data: z.object({ id: z.string() }),
});

const secondEvent = z.object({
  name: z.literal("shop/product.deleted"),
  data: z.object({ id: z.string() }),
});

new EventSchemas().fromZod([firstEvent, secondEvent]);
```

You can use the exported `LiteralZodEventSchema` type to provide some autocomplete when writing your events, too.

```ts
const ShopProductOrdered = z.object({
  name: z.literal("shop/product.ordered"),
  data: z.object({ productId: z.string() }),
}) satisfies LiteralZodEventSchema;
```
