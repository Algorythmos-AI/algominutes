import { z } from 'zod';

/**
 * Runtime shapes for the API responses the UI renders directly.
 *
 * `zod` has been a dependency of this project for a long time and was imported
 * nowhere. Server payloads were cast (`as Note`, `let data: any`) and then used
 * in render — so `hit.chunkText.length` on a hit whose `chunkText` came back
 * null throws *inside render*, React unmounts the whole tree, and the doctor
 * gets the crash screen. Not hypothetical: the search response was guarded only
 * by `Array.isArray(data.hits)`.
 *
 * Two rules here, both deliberate:
 *
 * 1. **Lenient about fields, strict about arrays.** A missing optional field
 *    gets a safe default via `.catch()`; an array entry that does not parse is
 *    dropped entirely. One bad row must not cost the whole response.
 *
 * 2. **The inferred type must match runtime.** The obvious spelling —
 *    `z.array(Item.nullable().catch(null))` — infers as `Item[]` in zod 4 while
 *    happily producing nulls at run time, so the type would lie in exactly the
 *    situation these schemas exist to prevent. `arrayOf` below parses each
 *    entry and filters the failures, so what you get is what the type says.
 */

/** An array whose unparseable entries are dropped rather than kept as null. */
function arrayOf<T extends z.ZodType>(item: T) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((entries) => {
      const kept: z.infer<T>[] = [];
      for (const entry of entries) {
        const parsed = item.safeParse(entry);
        if (parsed.success) kept.push(parsed.data);
      }
      return kept;
    });
}

export const CitationSchema = z.object({
  noteId: z.string(),
  noteTitle: z.string().nullable().catch(null),
  chunkText: z.string().catch(''),
  startMs: z.number().finite().catch(0),
  endMs: z.number().finite().catch(0),
});
export type Citation = z.infer<typeof CitationSchema>;

export const SearchHitSchema = z.object({
  noteId: z.string(),
  noteTitle: z.string().nullable().catch(null),
  chunkText: z.string().catch(''),
  startMs: z.number().finite().catch(0),
  endMs: z.number().finite().catch(0),
  score: z.number().finite().optional(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResponseSchema = z.object({
  hits: arrayOf(SearchHitSchema),
});

export const SharedSummarySchema = z.object({
  gist: z.string().nullable().catch(null),
  actionItems: arrayOf(z.string()),
  keyDecisions: arrayOf(z.string()),
});

export const SharedLineSchema = z.object({
  id: z.number(),
  speakerTag: z.number().nullable().catch(null),
  speakerName: z.string().nullable().catch(null),
  startMs: z.number().finite().nullable().catch(null),
  text: z.string().catch(''),
});
export type SharedLine = z.infer<typeof SharedLineSchema>;

export const SharedNoteSchema = z.object({
  note: z.object({
    title: z.string().nullable().catch(null),
    createdAt: z.string(),
    scope: z.string().catch(''),
  }),
  summary: SharedSummarySchema.nullable().catch(null),
  transcript: z
    .object({
      lines: arrayOf(SharedLineSchema),
      truncated: z.boolean().catch(false),
    })
    .nullable()
    .catch(null),
  expiresAt: z.string(),
});
export type SharedNoteData = z.infer<typeof SharedNoteSchema>;

/**
 * Parse, or return null and log. Never throws — a malformed response should
 * produce an error state, not take the app down with it.
 */
export function safeParse<T>(schema: z.ZodType<T>, value: unknown, what: string): T | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  console.error(`api_response_invalid:${what}`, result.error.issues.slice(0, 3));
  return null;
}
