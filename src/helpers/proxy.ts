/**
 * Creates a new `Proxy` that can be used to pretend to be any JS object. For
 * example, we can run methods and get properties of the proxy indefinitely.
 *
 * We can use this to return an object that will almost always be safe at
 * runtime, and mask it with types during dev.
 *
 *        const proxy = createInfiniteProxy();
 *
 *        proxy.things.are.looking(function (test) {
 *          console.log("Yeehaw!");
 *        }, 250).up;
 *
 * The specific use case for this is to enable step functions to run the
 * entirety of their flow each and every time they are called, with
 * little-to-no overhead.
 */
export function createInfiniteProxy(): any {
  return new Proxy(
    function () {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return createInfiniteProxy();
    },
    {
      apply() {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return createInfiniteProxy();
      },

      get(target, name) {
        switch (name) {
          case "constructor":
            return Function;

          case "prototype":
            return Function.prototype;

          case "inspect":
            return function () {
              return {};
            };

          default:
            if (typeof name === "symbol") {
              return function () {
                return "{}";
              };
            }

            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return createInfiniteProxy();
        }
      },
    }
  );
}
