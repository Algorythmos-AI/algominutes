// Client-side note editing helpers.
//
// Note edits are persisted through the backend POST /api/update-note endpoint,
// which dual-writes to Postgres (the system of record) and mirrors to the
// Firestore cache the SPA renders from. Routing edits through the backend keeps
// search/chat retrieval in sync — a renamed note or re-written gist updates the
// RAG index, not just the local view (and a reprocess can no longer silently
// wipe a manual edit).
//
// These helpers are shared by the manual editor in the note detail view
// (App.tsx) and the chat edit-commands (ChatTab.tsx) so both send the same
// payload shape. The live detail view still updates from the Firestore listener
// once the endpoint's mirror write lands (which also bumps updatedAt).
import { authedFetch } from './authedFetch';
import type { Note, Summary } from '../types';
import { readErrorJson } from './http';

export const workspaceIdFor = (uid: string) => `workspace_${uid}`;

// The fields the manual editor exposes. Lists are edited as raw string
// arrays and cleaned (trimmed, blanks dropped) on save.
export interface EditableNoteFields {
  title: string;
  gist: string;
  actionItems: string[];
  keyDecisions: string[];
}

// Build an EditableNoteFields draft from a note, for seeding the editor.
export function draftFromNote(note: Note): EditableNoteFields {
  return {
    title: note.title ?? '',
    gist: note.summary?.gist ?? '',
    actionItems: [...(note.summary?.actionItems ?? [])],
    keyDecisions: [...(note.summary?.keyDecisions ?? [])],
  };
}

// Merge edited fields back into a full Summary, preserving fields the editor
// doesn't touch (e.g. keyPoints).
function summaryFrom(existing: Summary | undefined, fields: EditableNoteFields): Summary {
  const summary: Summary = {
    gist: fields.gist.trim(),
    actionItems: fields.actionItems.map((s) => s.trim()).filter(Boolean),
    keyDecisions: fields.keyDecisions.map((s) => s.trim()).filter(Boolean),
  };
  if (existing?.keyPoints) summary.keyPoints = existing.keyPoints;
  return summary;
}

// POST an edit to the backend. Only the fields present are sent; the endpoint
// applies them to Postgres + Firestore. Throws with the server's message on
// failure so callers (manual editor, chat commands) can surface it.
async function postNoteEdit(
  uid: string,
  noteId: string,
  fields: { title?: string; summary?: Summary },
): Promise<void> {
  const resp = await authedFetch('/api/update-note', {
    noteId,
    workspaceId: workspaceIdFor(uid),
    ...(fields.title !== undefined ? { title: fields.title } : {}),
    ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
  });
  if (!resp.ok) {
    const data = (await readErrorJson(resp)) as { error?: string };
    throw new Error(data.error || `Couldn't save your changes (${resp.status}).`);
  }
}

// Save the full editable set (title + summary) from the manual editor.
export async function saveNoteEdits(
  uid: string,
  noteId: string,
  existing: Summary | undefined,
  fields: EditableNoteFields,
): Promise<void> {
  const title = fields.title.trim();
  if (!title) throw new Error('Title cannot be empty.');
  await postNoteEdit(uid, noteId, { title, summary: summaryFrom(existing, fields) });
}

// ─── Targeted mutations used by the chat edit-commands ───────────────

export async function renameNote(uid: string, noteId: string, title: string): Promise<void> {
  const next = title.trim();
  if (!next) throw new Error('Title cannot be empty.');
  await postNoteEdit(uid, noteId, { title: next });
}

// Apply a mutation to a note's summary, seeding a complete Summary from the
// current note so we never drop sibling fields on a partial write.
async function mutateSummary(uid: string, note: Note, mutate: (s: Summary) => Summary): Promise<void> {
  const base: Summary = {
    gist: note.summary?.gist ?? '',
    actionItems: [...(note.summary?.actionItems ?? [])],
    keyDecisions: [...(note.summary?.keyDecisions ?? [])],
  };
  if (note.summary?.keyPoints) base.keyPoints = note.summary.keyPoints;
  await postNoteEdit(uid, note.id, { summary: mutate(base) });
}

export async function appendActionItem(uid: string, note: Note, item: string): Promise<void> {
  const text = item.trim();
  if (!text) throw new Error('Action item cannot be empty.');
  await mutateSummary(uid, note, (s) => ({ ...s, actionItems: [...s.actionItems, text] }));
}

export async function appendKeyDecision(uid: string, note: Note, decision: string): Promise<void> {
  const text = decision.trim();
  if (!text) throw new Error('Key decision cannot be empty.');
  await mutateSummary(uid, note, (s) => ({ ...s, keyDecisions: [...s.keyDecisions, text] }));
}

export async function setSummaryGist(uid: string, note: Note, gist: string): Promise<void> {
  const text = gist.trim();
  if (!text) throw new Error('Summary cannot be empty.');
  await mutateSummary(uid, note, (s) => ({ ...s, gist: text }));
}
