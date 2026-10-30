/**
 * @module
 * The in-memory GitHub Git Data API the git-free push tests use. It is
 * published for apps as `fakeGitDataApi()` of the testing entry; the tests of
 * the SDK use the same implementation with its failure knobs.
 */
import { blobSha, createGitDataApi } from "../../agent/testing/gitDataApi.ts";

export { blobSha };

export const fakeGitHub = (): ReturnType<typeof createGitDataApi> => {
  return createGitDataApi();
};
