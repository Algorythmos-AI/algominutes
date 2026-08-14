# services/extractor

Server-side **document text extraction** for AlgoMinutes: PDF, DOCX, images (OCR) and YouTube.
Cloud Run, async, Node 24.

## Why this exists

Extraction used to run **in the browser** — `pdfjs-dist`, `mammoth` and `tesseract.js` in
`apps/web/src/lib/{documentText,ocr,imagePdf}.ts`, plus the transcoder's `youtube.js`. That code
**cannot survive into Swift or Kotlin**, which would force three separate implementations (iOS,
Android, web) of the same fiddly extraction logic. This service is the **one** implementation the
three clients share (BUILD-PLAN A3 / §3.2). Clients stop shipping `pdfjs-dist`/`mammoth`/`tesseract.js`
entirely and call these endpoints instead.

## Endpoints

`GET /health` → `ok`

All extraction routes are versioned (`/v1`, never broken — A3 "version from day one") and return:

```jsonc
{ "ok": true, "kind": "pdf", "text": "…", "chars": 1234, "traceId": "…", "meta": { … } }
```

| Route | Ported from | Engine |
|---|---|---|
| `POST /v1/extract/pdf` | `apps/web/src/lib/documentText.ts` → `extractPdfText` | `pdfjs-dist` (legacy Node build) text layer; image-only pages fall back to `pdftoppm` + OCR |
| `POST /v1/extract/docx` | `apps/web/src/lib/documentText.ts` → `extractDocxText` | `mammoth` |
| `POST /v1/extract/image` | `apps/web/src/lib/ocr.ts` | `tesseract.js` (WASM) |
| `POST /v1/extract/youtube` | `services/transcoder/src/youtube.js` | `yt-dlp` captions → text |

### Request body

The three byte endpoints (`pdf`, `docx`, `image`) accept **either** an inline upload **or** a storage
reference — the same split the transcoder uses for audio:

```jsonc
{ "storagePath": "gs://bucket/path/to/file.pdf" }   // preferred: client already uploaded to GCS
{ "bytesBase64": "<base64>" }                        // inline, for small files (≤ 24 MiB)
```

`youtube` takes a URL instead: `{ "url": "https://www.youtube.com/watch?v=…" }` (strict host
allowlist — YouTube hosts only). Optional `noteId` / `workspaceId` are carried through the logs for
correlation but are not required.

### Direct request or Cloud Tasks push

Every endpoint works both as a **direct** call (from a client or the `api` service) and as a **Cloud
Tasks push** — a task just POSTs the same JSON body. `traceId` comes from `X-Cloud-Trace-Context` when
present. **4xx** responses are permanent (bad input, unsupported file, restricted video — `ok:false`,
`permanent:true`, with a user-safe `error`); **5xx** are transient and safe for the queue to retry.

### Idempotency

Extraction is a **pure function of its input bytes**, so every endpoint is idempotent by construction:
the same input returns the same output. The service writes **no state** — there is no dedupe key or
`ON CONFLICT` to manage because there is nothing to conflict. (Statelessness was preferred over a
dedupe table per the A3 guidance.)

## Not ported / limitations

- **PDF OCR fallback** — the browser rendered image-only PDF pages to `<canvas>` then OCR'd them. Node
  has no headless canvas without `node-canvas` (cairo/pango), so pages are rasterized with poppler's
  `pdftoppm` (spawned) instead, then OCR'd. Same behaviour, real Node/system path. Bounded to the
  first 6 pages of small PDFs, as in the source.
- **OCR image pre-processing** — the browser applied a grayscale/contrast/resize canvas filter before
  OCR (`resizeImageForOcr`). No clean Node equivalent without `sharp` (libvips); dropped for P0 with a
  `TODO(extractor)`. Recognition still works on the raw bytes; add `sharp` if quality on real photos
  proves insufficient.
- **Captionless YouTube videos** — a video with no captions cannot become text without speech-to-text.
  That path is the **transcoder** (audio → STT v2); this endpoint returns a permanent `422` telling the
  caller to route such videos through the audio pipeline rather than duplicating STT here. Async wiring
  of extractor→transcoder is left to A7 (must not be a synchronous service-to-service call, §3.3).
- **`imagePdf.ts`** (image→PDF via `jspdf`) was a client-side *authoring* helper, not text extraction,
  so it is intentionally **not** part of this service.

## System dependencies (see `Dockerfile`)

- `poppler-utils` — `pdftoppm`, PDF page rasterization for the OCR fallback.
- `python3` + `pip` + `yt-dlp[default]` — YouTube caption fetch (yt-dlp is a Python wheel; the `default`
  extra bundles yt-dlp-ejs for YouTube's JS challenges).
- `tesseract.js` needs **no** system tesseract (ships its own WASM), but fetches `eng.traineddata` +
  the WASM core into `/tmp` at runtime — bake these into the image later to avoid a cold-start download.

## Operating cost / shape (per §3.3 — "tell me what a new service costs")

**A new async Cloud Run service = one more deploy, dashboard, alert and on-call surface.** Scales to
zero when idle (no floor cost). Per-request CPU/memory is spiky and bimodal: PDF-text and DOCX are
cheap (tens of ms, low memory); **OCR and YouTube are the cost drivers** — tesseract is CPU-bound
(seconds/image) and yt-dlp is network/CPU-bound, so size memory ~1–2 GiB, allow a generous request
timeout, and cap concurrency low (OCR is not cheap to run many-at-once in one container). Cold starts
carry the tesseract model + WASM download until it is baked into the image. Set the Cloud Tasks queue
`--max-attempts` low so 4xx (permanent) failures do not retry indefinitely.
