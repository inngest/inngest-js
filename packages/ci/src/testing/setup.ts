/**
 * Runs before every test file: gives the SDK the span API when it has none,
 * so span and origin assertions hold against any SDK. A test of the no-span
 * path takes it off again with `removeSpanStub`.
 *
 * @module
 */

import { installSpanStub } from "./spanStub.ts";

installSpanStub();
