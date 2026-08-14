// POST /v1/chat — grounded chat over meetings (functions/search-and-chat.cjs
// handleChatStream). The response is NOT JSON: it is a Server-Sent Events
// stream. The event payload shapes are modelled here so clients can type the
// stream, even though the transport is text/event-stream rather than a body.
import { z } from './zod';
import { SearchHit } from './search';

/** Request body. `noteId` scopes the conversation to one note (and makes an
 * unreachable note a hard 404). Source: handleChatStream body parse. */
export const ChatRequest = z
  .object({
    query: z.string().min(1),
    noteId: z.string().optional(),
  })
  .openapi('ChatRequest');

// ── SSE event payloads ────────────────────────────────────────────────
// The stream frames are:
//   event: citations  data: { hits }     — sent up front
//   data: { text }                        — incremental answer tokens
//   event: done        data: {}           — clean end
//   event: error       data: { error }    — upstream/stream failure

/** `event: citations` — the retrieved hits, sent before the answer streams. */
export const ChatCitationsEvent = z
  .object({ hits: z.array(SearchHit) })
  .openapi('ChatCitationsEvent');

/** A `data:` frame carrying an incremental chunk of the answer text. */
export const ChatTextEvent = z.object({ text: z.string() }).openapi('ChatTextEvent');

/** `event: done` — an empty object marks a clean end of stream. */
export const ChatDoneEvent = z.object({}).openapi('ChatDoneEvent');

/** `event: error` — a stream-level failure. Source: `{ error: 'stream_failed' }`. */
export const ChatErrorEvent = z.object({ error: z.string() }).openapi('ChatErrorEvent');

export type ChatRequest = z.infer<typeof ChatRequest>;
export type ChatCitationsEvent = z.infer<typeof ChatCitationsEvent>;
export type ChatTextEvent = z.infer<typeof ChatTextEvent>;
export type ChatDoneEvent = z.infer<typeof ChatDoneEvent>;
export type ChatErrorEvent = z.infer<typeof ChatErrorEvent>;
