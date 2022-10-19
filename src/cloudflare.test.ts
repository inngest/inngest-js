import * as CloudflareHandler from "./cloudflare";
import { testFramework } from "./test/helpers";

const originalProcess = process;

testFramework("Cloudflare", CloudflareHandler, {
  lifecycleChanges: () => {
    beforeEach(() => {
      jest.resetModules();
      process = undefined as unknown as NodeJS.Process;
    });

    afterEach(() => {
      process = originalProcess;
    });
  },
  envTests: () => {
    test("process should be undefined", () => {
      expect(process).toBeUndefined();
    });
  },
  handlerTests: () => {
    test.todo("should return a function");
  },
});
