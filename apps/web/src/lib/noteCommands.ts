// Client-side "edit command" layer for the chat tab.
//
// Before a chat message is sent to the RAG backend, we try to interpret it as
// a direct edit instruction ("rename my last note to X", "add an action item
// Y"). If it matches, we perform the Firestore write ourselves and hand back a
// confirmation reply — no backend call. If it doesn't match, we return null
// and the message flows to /api/chat as a normal question.
//
// Commands are intentionally conservative: a verb we don't recognise falls
// through to normal chat, and every successful edit names the note it touched
// so the change is transparent and easy to undo by hand.
import type { Note } from '../types';
import { renameNote, appendActionItem, appendKeyDecision, setSummaryGist } from './noteEdit';

export interface CommandResult {
  reply: string;
  // Note the command acted on, so the UI can offer a jump-to link.
  noteId?: string;
}

const stripQuotes = (s: string) => s.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();

// Phrases that mean "the newest note" rather than a title to match on.
const LAST_NOTE_RE = /^(?:the\s+|my\s+)?(?:last|latest|most\s+recent|newest|previous)\s+(?:note|recording|meeting|record)$/i;

// Resolve a note reference to a concrete note. `notes` is newest-first.
// Returns undefined if a non-empty reference matched nothing.
function resolveNote(ref: string | undefined, notes: Note[]): Note | undefined {
  if (!notes.length) return undefined;
  const r = stripQuotes(ref ?? '');
  if (!r || LAST_NOTE_RE.test(r)) return notes[0];
  const needle = r.toLowerCase();
  // Prefer an exact title, then a substring match.
  return (
    notes.find((n) => (n.title ?? '').toLowerCase() === needle) ??
    notes.find((n) => (n.title ?? '').toLowerCase().includes(needle))
  );
}

// Pull an optional trailing "… to/in/on <note reference>" off a command body,
// so "add action item Ship the beta to my last note" targets the note, not the
// item text. Only recognises explicit note references (last-note phrases or a
// quoted title) to avoid eating item text that legitimately contains "to".
function splitTrailingTarget(body: string): { text: string; ref?: string } {
  const m = body.match(
    /^(.*\S)\s+(?:to|in|on)\s+((?:the\s+|my\s+)?(?:last|latest|most\s+recent|newest|previous)\s+(?:note|recording|meeting|record)|"[^"]+"|'[^']+')\s*$/i,
  );
  if (m) return { text: m[1].trim(), ref: m[2] };
  return { text: body.trim() };
}

const notFound = (ref: string): CommandResult => ({
  reply: `I couldn't find a note matching "${stripQuotes(ref)}". Try "my last note" or the exact note title.`,
});

// Try to handle `text` as an edit command. Returns a CommandResult when the
// message was an edit instruction (handled or rejected with a reason), or null
// when it isn't a command and should go to the chat backend.
export async function tryHandleEditCommand(
  uid: string,
  text: string,
  notes: Note[],
): Promise<CommandResult | null> {
  const q = text.trim();

  // ── Rename / retitle ──────────────────────────────────────────────
  const rename = q.match(/^(?:rename|retitle|change(?:\s+the)?\s+title(?:\s+of)?)\s+(.+?)\s+to\s+(.+)$/i);
  if (rename) {
    const [, refRaw, titleRaw] = rename;
    const target = resolveNote(refRaw, notes);
    if (!target) return notFound(refRaw);
    const title = stripQuotes(titleRaw);
    if (!title) return { reply: 'What should the new title be?' };
    await renameNote(uid, target.id, title);
    return { reply: `Renamed "${target.title}" to "${title}".`, noteId: target.id };
  }

  // ── Add an action item ────────────────────────────────────────────
  const addAction = q.match(/^add(?:\s+an?)?\s+action\s+item[:\-]?\s+(.+)$/i);
  if (addAction) {
    const { text: itemRaw, ref } = splitTrailingTarget(addAction[1]);
    const target = resolveNote(ref, notes);
    if (!target) return ref ? notFound(ref) : { reply: "You don't have any notes to edit yet." };
    const item = stripQuotes(itemRaw);
    if (!item) return { reply: 'What action item should I add?' };
    await appendActionItem(uid, target, item);
    return { reply: `Added action item to "${target.title}": ${item}`, noteId: target.id };
  }

  // ── Add a key decision ────────────────────────────────────────────
  const addDecision = q.match(/^add(?:\s+an?)?\s+key\s+decision[:\-]?\s+(.+)$/i);
  if (addDecision) {
    const { text: decRaw, ref } = splitTrailingTarget(addDecision[1]);
    const target = resolveNote(ref, notes);
    if (!target) return ref ? notFound(ref) : { reply: "You don't have any notes to edit yet." };
    const decision = stripQuotes(decRaw);
    if (!decision) return { reply: 'What decision should I add?' };
    await appendKeyDecision(uid, target, decision);
    return { reply: `Added key decision to "${target.title}": ${decision}`, noteId: target.id };
  }

  // ── Replace the executive summary ─────────────────────────────────
  const setSummary = q.match(/^(?:set|change|update|rewrite|replace)\s+(?:the\s+)?(?:executive\s+)?summary\s+(?:of\s+(.+?)\s+)?to\s+(.+)$/i);
  if (setSummary) {
    const [, refRaw, gistRaw] = setSummary;
    const target = resolveNote(refRaw, notes);
    if (!target) return refRaw ? notFound(refRaw) : { reply: "You don't have any notes to edit yet." };
    const gist = stripQuotes(gistRaw);
    if (!gist) return { reply: 'What should the summary say?' };
    await setSummaryGist(uid, target, gist);
    return { reply: `Updated the summary of "${target.title}".`, noteId: target.id };
  }

  return null;
}
