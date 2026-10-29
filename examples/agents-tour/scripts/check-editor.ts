/**
 * @module
 * `pnpm tour:check-editor`: opens every page of a running tour in headless
 * Chromium and fails when the editor reports a TypeScript diagnostic on the
 * page's starting code, once the TypeScript worker has settled. Needs a
 * running tour (`TOUR_URL`, default http://127.0.0.1:17777) and Playwright
 * (`TOUR_PLAYWRIGHT`, the path of its `index.mjs`; `TOUR_CHROMIUM`, the
 * browser binary).
 */

export type {};

interface Page {
  goto(url: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
}

interface Playwright {
  chromium: {
    launch(options: { executablePath?: string }): Promise<{
      newPage(): Promise<Page>;
      close(): Promise<void>;
    }>;
  };
}

const base = process.env.TOUR_URL ?? "http://127.0.0.1:17777";
const { chromium } = (await import(
  process.env.TOUR_PLAYWRIGHT ?? "playwright"
)) as Playwright;
const index = (await (await fetch(`${base}/api/index`)).json()) as {
  lessons: { pages: { id: string }[] }[];
};
const browser = await chromium.launch({
  executablePath: process.env.TOUR_CHROMIUM,
});
const page = await browser.newPage();
const problems: string[] = [];
let checked = 0;

for (const lesson of index.lessons) {
  for (const { id } of lesson.pages) {
    await page.goto(`${base}/tour/${id}`);
    await page.waitForTimeout(500);

    const hasEditor = await page.evaluate<boolean>(
      "document.querySelector('.monaco-editor') !== null",
    );

    if (!hasEditor) {
      continue;
    }

    await page.waitForTimeout(3500);
    checked += 1;

    const markers = await page.evaluate<string[]>(
      `window.__tourMonaco.editor.getModelMarkers({}).map((marker) => {
        return marker.resource.path + ":" + marker.startLineNumber + " " + marker.message;
      })`,
    );

    for (const marker of markers) {
      problems.push(`${id}: ${marker}`);
    }
  }
}

await browser.close();

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log(`${checked} pages with code have no editor diagnostics.`);
