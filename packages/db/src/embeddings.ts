/**
 * Embeddings + chunking for the RAG pipeline.
 *
 * Uses Google's `text-embedding-004` (768-dim, cosine similarity)
 * available via the @google/generative-ai SDK. We chose this over
 * gemini-embedding-001 (3072-dim) because 4× smaller index storage
 * gives us recall headroom up to ~10M chunks before Vertex Vector
 * Search becomes worthwhile.
 *
 * Embedding writes are gated by isPostgresEnabled() — if Postgres is
 * not configured the embedder is a no-op so production deploys without
 * Cloud SQL still succeed.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getPool, isPostgresEnabled } from './db';
import { toSql as vectorToSql } from 'pgvector/pg';

const EMBED_MODEL = 'text-embedding-004';
const TARGET_TOKENS = 500;        // ~2000 chars
const OVERLAP_TOKENS = 50;        // ~200 chars
const APPROX_CHARS_PER_TOKEN = 4;

export interface TranscriptLine {
  speaker?: string | null;
  speakerTag?: number | null;
  text: string;
  startMs?: number;
  endMs?: number;
  time?: string;
}

export interface EmbeddingChunk {
  text: string;
  startMs: number;
  endMs: number;
}

function timeStrToMs(t?: string): number {
  if (!t) return 0;
  const parts = t.split(':').map((n) => Number(n) || 0);
  if (parts.length === 3) return ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return parts[0] * 1000;
}

/**
 * Split a transcript into ~500-token chunks with ~50-token overlap,
 * preferring speaker-turn boundaries when they fall in the right place.
 */
export function chunkTranscript(lines: TranscriptLine[]): EmbeddingChunk[] {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const targetChars = TARGET_TOKENS * APPROX_CHARS_PER_TOKEN;
  const overlapChars = OVERLAP_TOKENS * APPROX_CHARS_PER_TOKEN;

  const chunks: EmbeddingChunk[] = [];
  let buffer = '';
  let bufferStart: number | null = null;
  let bufferEnd = 0;

  const flush = () => {
    if (!buffer.trim()) return;
    chunks.push({
      text: buffer.trim(),
      startMs: bufferStart ?? 0,
      endMs: bufferEnd,
    });
    // Carry overlap forward.
    buffer = buffer.length > overlapChars ? buffer.slice(-overlapChars) : '';
    bufferStart = bufferEnd;
  };

  for (const line of lines) {
    const startMs = line.startMs ?? timeStrToMs(line.time);
    const endMs = line.endMs ?? startMs;
    const speaker = line.speaker ?? (line.speakerTag != null ? `Speaker ${line.speakerTag}` : null);
    const formatted = speaker ? `${speaker}: ${line.text}` : line.text;
    if (bufferStart === null) bufferStart = startMs;
    if (buffer.length + formatted.length + 1 > targetChars) flush();
    if (bufferStart === null) bufferStart = startMs;
    buffer += (buffer ? '\n' : '') + formatted;
    bufferEnd = endMs;
  }
  flush();
  return chunks;
}

/**
 * Embed a batch of strings via the Gemini SDK. Returns an array of
 * Float32 vectors aligned with the input order.
 */
export async function embedBatch(apiKey: string, inputs: string[]): Promise<number[][]> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: EMBED_MODEL });
  const out: number[][] = [];
  // The SDK exposes batchEmbedContents but contract is awkward; sequential is
  // fine at our chunk counts and lets us recover from per-item errors.
  for (const text of inputs) {
    const res = await model.embedContent({ content: { role: 'user', parts: [{ text }] } } as any);
    const values = (res as any)?.embedding?.values;
    if (!Array.isArray(values)) throw new Error('embedding_missing_values');
    out.push(values);
  }
  return out;
}

export interface EmbedAndStoreInput {
  noteId: string;
  workspaceId: string;
  apiKey: string;
  transcript: TranscriptLine[];
  log: { info: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
}

/**
 * Embed a transcript and write the vectors into the `embeddings` table.
 * Skipped silently when Postgres is disabled or when the transcript is
 * empty.
 */
export async function embedAndStore(input: EmbedAndStoreInput): Promise<{ chunkCount: number }> {
  if (!isPostgresEnabled()) return { chunkCount: 0 };
  const chunks = chunkTranscript(input.transcript);
  if (chunks.length === 0) return { chunkCount: 0 };
  const startMs = Date.now();
  let vectors: number[][];
  try {
    vectors = await embedBatch(input.apiKey, chunks.map((c) => c.text));
  } catch (err) {
    input.log.error({ err, noteId: input.noteId }, 'embedding_call_failed');
    return { chunkCount: 0 };
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM embeddings WHERE note_id = $1', [input.noteId]);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const v = vectors[i];
      await client.query(
        `INSERT INTO embeddings (note_id, workspace_id, chunk_text, start_ms, end_ms, embedding, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [input.noteId, input.workspaceId, c.text, c.startMs, c.endMs, vectorToSql(v), EMBED_MODEL],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    input.log.error({ err, noteId: input.noteId }, 'embedding_write_failed');
    return { chunkCount: 0 };
  } finally {
    client.release();
  }
  input.log.info(
    { noteId: input.noteId, chunkCount: chunks.length, latencyMs: Date.now() - startMs },
    'embeddings_indexed',
  );
  return { chunkCount: chunks.length };
}
