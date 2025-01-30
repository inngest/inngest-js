---
"inngest": patch
---

Allow wildcard event typing with `.fromRecord()`

The following schema is now valid:

```ts
export const schemas = new EventSchemas().fromRecord<{
  "app/blog.post.*":
    | {
        name: "app/blog.post.created";
        data: {
          postId: string;
          authorId: string;
          createdAt: string;
        };
      }
    | {
        name: "app/blog.post.published";
        data: {
          postId: string;
          authorId: string;
          publishedAt: string;
        };
      };
}>();
```

When creating a function, this allows you to appropriately type narrow the event to pull out the correct data:

```ts
inngest.createFunction(
  { id: "my-fn" },
  { event: "app/blog.post.*" },
  async ({ event }) => {
    if (event.name === "app/blog.post.created") {
      console.log("Blog post created at:", event.data.createdAt);
    } else if (event.name === "app/blog.post.published") {
      console.log("Blog post published at:", event.data.publishedAt);
    }
  }
);
```
