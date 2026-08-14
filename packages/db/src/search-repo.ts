/**
 * Hybrid retrieval over the meeting corpus.
 *
 * For a given query and uid, we:
 *   1. Resolve the workspaces the user is a member of (from
 *      workspace_members).
 *   2. Run two parallel candidate searches:
 *      - Vector cosine over `embeddings.embedding` (HNSW index)
 *      - pg_trgm similarity over `transcript_lines.text`
 *   3. Fuse the two ranked lists via reciprocal rank fusion (k=60)
 *      and return the top-K results.
 *
 * Each hit links back to a transcript timestamp so the UI can deep-link
 * into the playback at the exact moment the line was spoken.
 */
import { getPool } from './db';
import { embedBatch } from './embeddings';
import { toSql as vectorToSql } from 'pgvector/pg';

export interface SearchHit {
  noteId: string;
  noteTitle: string | null;
  chunkText: string;
  startMs: number;
  endMs: number;
  score: number;
  source: 'vector' | 'keyword' | 'fused';
}

const RRF_K = 60;
const PER_LIST_LIMIT = 25;

async function memberWorkspaces(uid: string): Promise<string[]> {
  const res = await getPool().query<{ workspace_id: string }>(
    `SELECT workspace_id FROM workspace_members WHERE uid = $1`,
    [uid],
  );
  return res.rows.map((r) => r.workspace_id);
}

export async function searchMeetings(opts: {
  uid: string;
  query: string;
  k?: number;
  apiKey: string;
}): Promise<SearchHit[]> {
  const k = Math.min(Math.max(opts.k ?? 10, 1), 50);
  const workspaces = await memberWorkspaces(opts.uid);
  if (workspaces.length === 0) return [];

  // ── Vector candidates ────────────────────────────────────────────
  let vectorRows: { note_id: string; title: string | null; chunk_text: string; start_ms: number; end_ms: number; distance: number }[] = [];
  try {
    const [vec] = await embedBatch(opts.apiKey, [opts.query]);
    const res = await getPool().query(
      `SELECT e.note_id, n.title, e.chunk_text, e.start_ms, e.end_ms,
              e.embedding <=> $1::vector AS distance
         FROM embeddings e
         JOIN notes n ON n.id = e.note_id
        WHERE e.workspace_id = ANY($2)
          AND n.deleted_at IS NULL
        ORDER BY e.embedding <=> $1::vector
        LIMIT $3`,
      [vectorToSql(vec), workspaces, PER_LIST_LIMIT],
    );
    vectorRows = res.rows;
  } catch (_err) {
    // fall through to keyword-only retrieval if the embedding call fails
  }

  // ── Keyword candidates (pg_trgm) ─────────────────────────────────
  const kwRes = await getPool().query(
    `SELECT t.note_id,
            n.title,
            t.text AS chunk_text,
            t.start_ms,
            t.end_ms,
            similarity(t.text, $1) AS sim
       FROM transcript_lines t
       JOIN notes n ON n.id = t.note_id
      WHERE n.workspace_id = ANY($2)
        AND n.deleted_at IS NULL
        AND t.text % $1
      ORDER BY similarity(t.text, $1) DESC
      LIMIT $3`,
    [opts.query, workspaces, PER_LIST_LIMIT],
  );

  // ── Reciprocal rank fusion ────────────────────────────────────────
  const fused = new Map<string, SearchHit>();
  const fuseAdd = (key: string, rank: number, source: 'vector' | 'keyword', payload: Omit<SearchHit, 'score' | 'source'>) => {
    const inc = 1 / (RRF_K + rank);
    const existing = fused.get(key);
    if (existing) {
      existing.score += inc;
      existing.source = 'fused';
    } else {
      fused.set(key, { ...payload, score: inc, source });
    }
  };

  vectorRows.forEach((r, idx) => {
    const key = `${r.note_id}:${r.start_ms}`;
    fuseAdd(key, idx, 'vector', {
      noteId: r.note_id,
      noteTitle: r.title,
      chunkText: r.chunk_text,
      startMs: r.start_ms,
      endMs: r.end_ms,
    });
  });
  kwRes.rows.forEach((r: any, idx: number) => {
    const key = `${r.note_id}:${r.start_ms}`;
    fuseAdd(key, idx, 'keyword', {
      noteId: r.note_id,
      noteTitle: r.title,
      chunkText: r.chunk_text,
      startMs: r.start_ms,
      endMs: r.end_ms,
    });
  });

  return Array.from(fused.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
