# Magic Hour image and video workflows

Generate one image or animate a completed image with the official
[Magic Hour Node.js SDK](https://github.com/magichourhq/magic-hour-node).
Inngest checkpoints the accepted project ID, then triggers a separate workflow
that retrieves the result. A new recovery event can read the same paid project
without creating another one. This example needs no LLM-provider account.

## Run locally

Requires Node.js 22.15+ and pnpm (tested with Node.js 24.21.0). This example uses Inngest 4.26.0 and Magic Hour
0.86.0, with the standard Node HTTP adapter and no frontend build.

Normal dependency installation emitted seven OpenTelemetry peer-version
warnings. No overrides, forced peer resolution or warning suppression were
applied. Review these warnings when changing dependency versions.

1. Install the example's dependencies:

   ```sh
   cd examples/with-magic-hour
   pnpm install
   ```

2. Provide `MAGIC_HOUR_API_KEY` to the app process through your secret manager.
   Create a key in the [Magic Hour developer dashboard](https://magichour.ai/developer).
   Keep it server-side. Do not put keys in event JSON, source control or logs.
   Start the app in local development mode:

   ```sh
   INNGEST_DEV=http://127.0.0.1:8288 pnpm dev
   ```

3. In another terminal, run the [Inngest Dev Server](https://www.inngest.com/docs/local-development):

   ```sh
   inngest dev --host 127.0.0.1 --no-discovery -u http://127.0.0.1:3047/api/inngest
   ```

   Open `http://127.0.0.1:8288`. Confirm the app and its two functions are listed.
   If port 3047 is occupied, set `PORT` on the app process and update `-u`.
   The Dev Server needs no cloud account. Keep it private; local event invocation
   is not a public production API or an authorization boundary.

   Save accepted project IDs before stopping a local Dev Server. Its default
   local state is not a production job store. To retain local history, use the
   CLI's `--persist` and `--sqlite-dir` options with a private directory outside
   this checkout; protect that directory like application data.

Run this example directly with the `pnpm dev` command documented here.
The current SDK repository's `pnpm dev:example` selector accepts only
`framework-*` and `bun*` names, so it does not select `with-magic-hour`.
No runner changes are included. Do not commit an example lockfile.

## Create one image

In the Dev Server's **Test Event** interface, send this once:

```json
{
  "name": "magichour/media.create",
  "data": {
    "kind": "image",
    "prompt": "A studio product photograph of a blue ceramic mug on a warm white background, soft window light, no text or logos"
  }
}
```

The profile creates one square Z-Image Turbo image at 640px. Its expected charge
is 5 Magic Hour credits. Review [current API pricing](https://magichour.ai/api)
before use; the returned `creditsCharged` is authoritative.

Open the create run and retain its `projectId`. Its completed creation step
triggers `magichour/media.recover`. Open that recovery run to inspect the status,
actual credits and temporary image download URL. Review the generated image
before using it as a product depiction. Text-to-image does not preserve a real
product reference.

## Animate the completed image

Use that image's project ID in a new event. The app retrieves its fresh download
URL internally and supplies it to Magic Hour as the video input:

```json
{
  "name": "magichour/media.create",
  "data": {
    "kind": "video",
    "imageProjectId": "REPLACE_WITH_COMPLETED_IMAGE_PROJECT_ID",
    "prompt": "A slow camera push-in toward the ceramic mug, subtle changing window light, the mug stays still"
  }
}
```

This requests one three-second LTX-2.5 video at 480p with audio disabled. The
expected charge is 72 credits at the current
[24-credit-per-second 480p rate](https://magichour.ai/models/ltx-2-5).
The response records the actual charge. This is an additional paid generation;
the source image is read without creating another image. The same recovery
workflow retrieves the resulting video's status and temporary downloads.

## Recover without another generation

If a run stops, or a download URL expires, send a **new recovery event** with
the retained ID and its correct kind:

```json
{
  "name": "magichour/media.recover",
  "data": {
    "kind": "video",
    "projectId": "REPLACE_WITH_ACCEPTED_VIDEO_PROJECT_ID"
  }
}
```

Use `"kind": "image"` for an image project. Recovery uses only project GET
requests. Each run makes at most 24 reads, separated by five-second durable
waits. SDK requests have a 20-second timeout; this is a read-count bound, not a
guaranteed two-minute wall-clock limit. If still pending, the result includes
`pending: true`. Send another recovery event with the same ID. `error` and
`canceled` are returned as terminal states; do not treat them as completed
media. `draft` remains pending and is polled alongside `queued` and `rendering`.

Signed download URLs are private, temporary bearer links. Keep the Dev Server,
event history and outputs private. Download completed media to your own storage
before expiry without forwarding the Magic Hour API key. A new recovery event
refreshes the URLs; replaying a memoized completed step may return an old URL.

## Retries and the acceptance window

Both Inngest functions set `retries: 0`, and each SDK call sets
`retries: { maxRetries: 0 }`. The SDK convenience `generate()` method is not used.
SDK failures become safe `NonRetriableError` messages without logging raw
request/response data.

A completed creation step retains its project ID in Inngest. There is still a
window between Magic Hour accepting a paid request and Inngest checkpointing
the response: a timeout, connection loss or process crash can leave acceptance
unknown. Inspect your Magic Hour projects before deciding to create again.
This example does not provide exactly-once creation or a public idempotency
guarantee. Rerunning a creation event, or adding automatic retries/fallbacks,
can create additional paid projects. Recover by ID instead.

## Deploy or use with Next.js

The plain Node server binds only to `127.0.0.1`; deploying it does not make
its endpoint publicly reachable. For production, place it behind your normal
reverse proxy, or use an official Inngest framework adapter as described below.
Configure the Magic Hour secret and ordinary Inngest event and signing keys,
connect the app in your Inngest environment, protect the application route that
sends creation events, and remove `INNGEST_DEV`.

To add the functions to a `create-next-app` project, import `inngest` and
`functions` from `functions.mjs` in your route and use the official
[`inngest/next` adapter](https://www.inngest.com/docs/getting-started/nextjs-quick-start).
Keep `MAGIC_HOUR_API_KEY` on the server. The plain Node server in `index.mjs` is
not needed in that deployment.

## Learn more

- [Inngest functions](https://www.inngest.com/docs/reference/typescript/v4/functions/create)
- [Magic Hour API reference](https://docs.magichour.ai/)
- [Magic Hour privacy policy](https://magichour.ai/privacy-policy)
