// POST /v1/notes/:id/speakers — name the diarised speakers of a note
// (diarisation §4 / ADR 0005). Renaming "Speaker 2" → "Priya" updates one row
// in the note_speakers map; note-read then resolves every line for tag 2 to
// "Priya" (falling back to "Speaker N" when unmapped). Per-note only for v1.
//
// Authz: the write goes through the repo layer (@algominutes/db), whose upsert
// is gated by an EXISTS against notes + workspace_members — a non-member's write
// touches nothing. We also apply the app-level workspace_${uid} ownership check
// up front, matching every other note route.

import intelligenceModule from '@algominutes/ai/intelligence.cjs';
import { setNoteSpeakers, getNoteSpeakers } from '@algominutes/db/note-speakers-repo';

const { isValidId } = intelligenceModule;

const MAX_NAME_LEN = 80;
const MAX_SPEAKERS = 32; // more than any real meeting; bounds a malicious payload

// Accept either a single { speakerTag, name } or a batch { speakers: [...] }.
function parseEntries(body) {
  const raw = Array.isArray(body?.speakers)
    ? body.speakers
    : (body && body.speakerTag != null ? [{ speakerTag: body.speakerTag, name: body.name }] : []);
  const out = [];
  for (const e of raw.slice(0, MAX_SPEAKERS)) {
    const tag = Number(e?.speakerTag);
    if (!Number.isInteger(tag) || tag <= 0) continue;
    // name may be '' → clears the mapping (revert to "Speaker N"). Non-strings
    // are rejected; a string is trimmed and length-capped.
    if (e.name != null && typeof e.name !== 'string') continue;
    const name = (e.name ?? '').slice(0, MAX_NAME_LEN);
    out.push({ speakerTag: tag, name });
  }
  return out;
}

export async function setNoteSpeakersRoute(req, res) {
  const uid = req.uid;
  const noteId = req.params.id;
  const { workspaceId } = req.body || {};

  if (!isValidId(noteId)) {
    return res.status(400).json({ error: 'Missing or invalid note id' });
  }
  // workspaceId is optional in the body, but if present it must be the caller's
  // own workspace — same guard as the other note routes.
  if (workspaceId != null && workspaceId !== `workspace_${uid}`) {
    return res.status(403).json({ error: 'Workspace mismatch' });
  }

  const entries = parseEntries(req.body);
  if (!entries.length) {
    return res.status(400).json({ error: 'No valid speaker entries provided' });
  }

  const reqLog = req.log.child({ uid, noteId, workspaceId: `workspace_${uid}` });
  try {
    const written = await setNoteSpeakers(uid, noteId, entries);
    if (written.length === 0) {
      // No rows written ⇒ caller is not a member of this note's workspace, or
      // the note is deleted/absent. Do not distinguish (avoid leaking existence).
      reqLog.warn({ requested: entries.length }, 'set_note_speakers_forbidden');
      return res.status(404).json({ error: 'Note not found' });
    }
    const speakers = await getNoteSpeakers(uid, noteId);
    reqLog.info({ written: written.length }, 'set_note_speakers_ok');
    return res.status(200).json({ ok: true, noteId, speakers });
  } catch (err) {
    reqLog.error({ err }, 'set_note_speakers_failed');
    return res.status(500).json({ error: 'Failed to update speakers' });
  }
}
