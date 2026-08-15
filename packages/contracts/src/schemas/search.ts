// POST /v1/search — hybrid retrieval (functions/search-and-chat.cjs
// handleSearch). Also the citation shape reused by /v1/chat.
import { z } from './zod';

/** Request body. `k` is result count (default 10); `noteId` narrows retrieval
 * to one note as an *additional* predicate. Source: handleSearch body parse. */
export const SearchRequest = z
  .object({
    query: z.string().min(1),
    k: z.number().int().min(1).max(50).optional(),
    noteId: z.string().optional(),
  })
  .openapi('SearchRequest');

/**
 * One retrieval hit — also used as a chat citation. `score` and `source` are
 * present on server output but tolerated-optional by the clients. `source` is
 * the fusion origin.
 *
 * Source: functions/search-and-chat.cjs fused payload, reconciled with
 * apps/ios/AlgoMinutes/Models/SearchHit.swift (`noteTitle?`, `score?`, `source?`)
 * and src/lib/apiSchemas.ts `SearchHitSchema`. `noteTitle` is nullable per the
 * web schema; the DB join can return a null title.
 */
export const SearchHit = z
  .object({
    noteId: z.string(),
    noteTitle: z.string().nullable(),
    chunkText: z.string(),
    startMs: z.number(),
    endMs: z.number(),
    score: z.number().optional(),
    source: z.enum(['vector', 'keyword', 'fused']).optional(),
  })
  .openapi('SearchHit');

/** `{ hits }`. Source: handleSearch success body. */
export const SearchResponse = z
  .object({
    hits: z.array(SearchHit),
  })
  .openapi('SearchResponse');

export type SearchRequest = z.infer<typeof SearchRequest>;
export type SearchHit = z.infer<typeof SearchHit>;
export type SearchResponse = z.infer<typeof SearchResponse>;
