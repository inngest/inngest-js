/**
 * @module
 * Realistic issues and pull requests for the fake GitHub: the first few are
 * there when the tour starts, and the GitHub tab opens the others on request.
 */

export interface IssueFixture {
  title: string;
  body: string;
}

export interface PrFixture {
  title: string;
  body: string;
  branch: string;
  // One changed file; `patch` is a unified diff hunk.
  file: string;
  patch: string;
}

export const issueFixtures: IssueFixture[] = [
  {
    title: "Login button does nothing on Safari 17",
    body: "Clicking Sign in does not submit the form. Works in Chrome and Firefox. Console shows `TypeError: Object.groupBy is not a function`.",
  },
  {
    title: "Dark mode flashes white on first paint",
    body: "With the system theme set to dark, the page flashes white for about 200ms before the theme class is applied.",
  },
  {
    title: "Add CSV export to the usage page",
    body: "Finance needs a way to download monthly usage as CSV. A button next to the date picker would be enough.",
  },
  {
    title: "Rate limit headers missing on 429 responses",
    body: "The API returns 429 but no `Retry-After` header, so clients cannot back off properly.",
  },
  {
    title: "Docs: the quickstart skips installing the CLI",
    body: "Step 2 of the quickstart runs `acme dev` but the CLI install step is missing from the page.",
  },
  {
    title: "Pagination returns duplicate rows when sorting by created_at",
    body: "Rows with the same `created_at` appear on both page 1 and page 2. Needs a stable tiebreaker such as `id`.",
  },
  {
    title: "Webhook retries stop after 3 attempts",
    body: "The docs say 8 attempts with backoff, but our logs show the deliveries stop after the third failure.",
  },
  {
    title: "Feature request: keyboard shortcuts for the command palette",
    body: "Would love Cmd+K to open the palette and arrow keys to move between results.",
  },
  {
    title: "Memory usage grows steadily in the worker process",
    body: "RSS climbs by about 40MB per hour under constant load. Heap snapshots show growing `Map` instances in the job cache.",
  },
  {
    title: "How do I rotate API keys without downtime?",
    body: "We want to rotate keys every 90 days. Is there a way to have two active keys at once?",
  },
  {
    title: "Broken link in the footer to the privacy policy",
    body: "The Privacy link in the footer returns 404. It should point to /legal/privacy.",
  },
  {
    title: "Sign in button unresponsive in Safari",
    body: "On Safari the Sign in button stays disabled after typing credentials. Chrome is fine.",
  },
  {
    title: "Timezone is wrong in email digests",
    body: "Digests are sent at 9am UTC for everyone, ignoring the timezone set in the profile.",
  },
  {
    title: "Add an option to disable telemetry",
    body: "We run in an air gapped environment. Please add `ACME_TELEMETRY=0` or a config flag.",
  },
];

export const prFixtures: PrFixture[] = [
  {
    title: "docs: fix typo in the quickstart",
    body: "Fixes a typo (`recieve` to `receive`) in the quickstart page.",
    branch: "docs/quickstart-typo",
    file: "docs/quickstart.md",
    patch:
      "@@ -12,3 +12,3 @@\n-You will recieve a confirmation email.\n+You will receive a confirmation email.",
  },
  {
    title: "fix: stable sort tiebreaker for paginated lists",
    body: "Adds `id` as a secondary sort key so rows with the same `created_at` no longer repeat across pages.\n\nFixes #6",
    branch: "fix/pagination-tiebreak",
    file: "src/db/list.ts",
    patch:
      "@@ -40,4 +40,4 @@\n-  .orderBy('created_at')\n+  .orderBy('created_at')\n+  .orderBy('id')",
  },
  {
    title: "chore: bump typescript to 5.9",
    body: "Routine dependency bump. Type check and tests pass locally.",
    branch: "chore/typescript-5-9",
    file: "package.json",
    patch:
      '@@ -18,1 +18,1 @@\n-    "typescript": "^5.8.3"\n+    "typescript": "^5.9.2"',
  },
  {
    title: "feat: add CSV export to the usage page",
    body: "Adds an Export CSV button that streams the current month's usage rows.\n\n- new `/api/usage.csv` route\n- button in the usage header",
    branch: "feat/usage-csv",
    file: "src/routes/usage.ts",
    patch:
      "@@ -1,0 +1,12 @@\n+export const csv = async (req, res) => {\n+  const rows = await usage.forMonth(req.query.month);\n+  res.setHeader('content-type', 'text/csv');\n+  for (const row of rows) {\n+    res.write(row.day + ',' + row.units + '\\n');\n+  }\n+  res.end();\n+};",
  },
  {
    title: "WIP: rewrite auth middleware",
    body: "",
    branch: "wip/auth-rewrite",
    file: "src/auth/middleware.ts",
    patch:
      "@@ -1,8 +1,3 @@\n-export const auth = verify(token);\n+// TODO\n+export const auth = () => true;",
  },
  {
    title: "fix: add Retry-After header to 429 responses",
    body: "Sets `Retry-After` from the limiter's reset time.\n\nFixes #4",
    branch: "fix/retry-after",
    file: "src/middleware/limit.ts",
    patch:
      "@@ -22,2 +22,3 @@\n   res.status(429);\n+  res.setHeader('Retry-After', String(Math.ceil(reset / 1000)));",
  },
  {
    title: "test: cover empty config file",
    body: "Adds a regression test for the startup panic with an empty `acme.toml`.",
    branch: "test/empty-config",
    file: "src/config.test.ts",
    patch:
      "@@ -30,0 +30,6 @@\n+test('empty file uses defaults', () => {\n+  expect(load('')).toEqual(defaults);\n+});",
  },
  {
    title: "perf: index search columns",
    body: "Adds a trigram index on `records.title`. Search on 50k rows drops from 3s to 80ms in my local run.",
    branch: "perf/search-index",
    file: "migrations/0042_search_index.sql",
    patch:
      "@@ -0,0 +1,2 @@\n+CREATE EXTENSION IF NOT EXISTS pg_trgm;\n+CREATE INDEX records_title_trgm ON records USING gin (title gin_trgm_ops);",
  },
  {
    title: "docs: document webhook retry schedule",
    body: "Documents the real schedule: 8 attempts with exponential backoff up to 6 hours.",
    branch: "docs/webhook-retries",
    file: "docs/webhooks.md",
    patch:
      "@@ -44,2 +44,3 @@\n-Failed deliveries are retried a few times.\n+Failed deliveries are retried 8 times with exponential backoff, up to 6 hours apart.",
  },
  {
    title: "feat: telemetry opt-out via ACME_TELEMETRY=0",
    body: "Reads `ACME_TELEMETRY` at startup and skips sending usage pings when it is `0`.",
    branch: "feat/telemetry-opt-out",
    file: "src/telemetry.ts",
    patch:
      "@@ -5,2 +5,4 @@\n export const send = async (event) => {\n+  if (process.env.ACME_TELEMETRY === '0') return;\n   await post('/v1/ping', event);",
  },
  {
    title: "fix: close db connections on shutdown",
    body: "The pool was never drained on SIGTERM, which left connections open in CI.",
    branch: "fix/pool-shutdown",
    file: "src/server.ts",
    patch:
      "@@ -60,1 +60,3 @@\n-process.on('SIGTERM', () => server.close());\n+process.on('SIGTERM', async () => {\n+  server.close();\n+  await pool.end();\n+});",
  },
  {
    title: "chore: remove unused lodash dependency",
    body: "Nothing imports lodash anymore. Removes it from package.json and the lockfile.",
    branch: "chore/drop-lodash",
    file: "package.json",
    patch: '@@ -12,1 +11,0 @@\n-    "lodash": "^4.17.21",',
  },
  {
    title: "feat: command palette keyboard shortcut",
    body: "Cmd/Ctrl+K opens the palette; arrow keys move; Enter selects.",
    branch: "feat/palette-shortcut",
    file: "src/ui/palette.tsx",
    patch:
      "@@ -18,0 +18,8 @@\n+useEffect(() => {\n+  const onKey = (e) => {\n+    if ((e.metaKey || e.ctrlKey) && e.key === 'k') setOpen(true);\n+  };\n+  window.addEventListener('keydown', onKey);\n+  return () => window.removeEventListener('keydown', onKey);\n+}, []);",
  },
  {
    title: "fix: dark mode flash on first paint",
    body: "Sets the theme class from an inline script in `<head>` before the first paint.\n\nFixes #2",
    branch: "fix/dark-flash",
    file: "src/ui/index.html",
    patch:
      "@@ -3,0 +3,3 @@\n+<script>\n+  document.documentElement.dataset.theme = localStorage.theme || 'system';\n+</script>",
  },
];
