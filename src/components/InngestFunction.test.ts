import { InngestFunction } from "./InngestFunction";

describe("#generateID", () => {
  it("Returns a correct name", () => {
    const fn = () =>
      new InngestFunction(
        { name: "HELLO 👋 there mr Wolf 🥳!" },
        { event: "test/event.name" },
        () => undefined
      );
    expect(fn().id("MY MAGIC APP 🥳!")).toEqual(
      "my-magic-app-hello-there-mr-wolf"
    );
    expect(fn().id()).toEqual("hello-there-mr-wolf");
  });
});
