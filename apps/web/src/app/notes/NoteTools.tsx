import { useState, type ReactNode } from 'react';
import { SUMMARY_TEMPLATES, type NoteReadResponse } from '@algominutes/contracts';
import { ApiError } from '../../lib/api/errors';
import { reportCrash } from '../../lib/crashReport';
import { useApi } from '../ApiContext';
import { Modal } from '../Modal';
import { useNotice } from '../Notice';

type Summary = NonNullable<NoteReadResponse['summary']>;
type Tool = null | 'rename' | 'edit' | 'regenerate' | 'feedback' | 'export';

interface Props {
  noteId: string;
  workspaceId: string;
  title: string;
  summary: Summary | null;
  /** Re-read the note after a change the page must show. */
  reload: () => void;
}

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

/** The note's tools, as on iOS's note screen: rename, edit the summary, regenerate, feedback and export. */
export function NoteTools({ noteId, workspaceId, title, summary, reload }: Props) {
  const { api } = useApi();
  const notice = useNotice();
  const [tool, setTool] = useState<Tool>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That didn’t work. Try again.');
      reportCrash('notes.tool', err, { source: tool ?? '' });
    } finally {
      setBusy(false);
    }
  };
  const open = (t: Tool) => {
    setError(null);
    setTool(t);
  };
  const btn = 'rounded-lg border border-border px-3 py-2';

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={() => open('rename')}>Rename</button>
        {summary && <button type="button" className={btn} onClick={() => open('edit')}>Edit summary</button>}
        <button type="button" className={btn} onClick={() => open('regenerate')}>Regenerate summary</button>
        <button type="button" className={btn} onClick={() => open('export')}>Export</button>
        <button type="button" className={btn} onClick={() => open('feedback')}>Rate this note</button>
      </div>

      {tool === 'rename' && (
        <RenameDialog
          initial={title}
          busy={busy}
          error={error}
          onCancel={() => setTool(null)}
          onSave={(next) =>
            run(async () => {
              await api.updateNote({ noteId, workspaceId, title: next });
              setTool(null);
              notice.show('Renamed.');
              reload();
            })
          }
        />
      )}

      {tool === 'edit' && summary && (
        <EditSummaryDialog
          summary={summary}
          busy={busy}
          error={error}
          onCancel={() => setTool(null)}
          onSave={(edit) =>
            run(async () => {
              await api.updateNote({ noteId, workspaceId, summary: edit });
              setTool(null);
              notice.show('Summary saved.');
              reload();
            })
          }
        />
      )}

      {tool === 'regenerate' && (
        <RegenerateDialog
          busy={busy}
          error={error}
          onCancel={() => setTool(null)}
          onRegenerate={(template, confirmOverwrite) =>
            run(async () => {
              try {
                await api.regenerateSummary({ noteId, workspaceId, template, confirmOverwrite });
              } catch (err) {
                if (err instanceof ApiError && err.kind === 'conflict') {
                  const code = (err.body as { error?: string } | null)?.error;
                  if (code === 'manual_edits_present') throw new ApiError('conflict', { message: 'You edited this summary. Choose “Replace my edits” to regenerate it anyway.', body: err.body });
                  if (code === 'already_regenerating') throw new ApiError('conflict', { message: 'This summary is already being regenerated.', body: err.body });
                }
                throw err;
              }
              setTool(null);
              notice.show('Regenerating the summary. It updates here when it’s ready.');
            })
          }
        />
      )}

      {tool === 'feedback' && (
        <FeedbackDialog
          busy={busy}
          error={error}
          onCancel={() => setTool(null)}
          onSend={(kind, rating, comment) =>
            run(async () => {
              await api.noteFeedback({ noteId, workspaceId, kind, rating, comment: comment || null });
              setTool(null);
              notice.show('Thanks for the feedback.');
            })
          }
        />
      )}

      {tool === 'export' && (
        <ExportDialog
          busy={busy}
          error={error}
          onCancel={() => setTool(null)}
          onExport={(scope) =>
            run(async () => {
              try {
                const { blob, fileName } = await api.exportNote({ noteId, workspaceId, scope, format: 'docx' });
                download(blob, fileName ?? `${title || 'AlgoMinutes note'}.docx`);
                setTool(null);
              } catch (err) {
                if (err instanceof ApiError && err.kind === 'too_large') {
                  throw new ApiError('too_large', { message: 'This transcript is too long for a Word document. Export the summary only.' });
                }
                throw err;
              }
            })
          }
        />
      )}
    </>
  );
}

/** Saves a blob as a file, through a temporary object URL. */
export function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Dialog({ title, children, onCancel }: { title: string; children: ReactNode; onCancel: () => void }) {
  return (
    <Modal title={title} onClose={onCancel}>
      {children}
    </Modal>
  );
}

function Footer({ busy, error, label, onCancel, disabled }: { busy: boolean; error: string | null; label: string; onCancel: () => void; disabled?: boolean }) {
  return (
    <>
      {error && <p role="alert" className="mt-3 text-danger">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button type="submit" disabled={busy || disabled} className="rounded-xl bg-accent px-4 py-2 font-semibold text-white disabled:opacity-60">{busy ? 'Working…' : label}</button>
        <button type="button" className="px-4 py-2 text-muted" onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}

const field = 'mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-heading';

function RenameDialog({ initial, busy, error, onCancel, onSave }: { initial: string; busy: boolean; error: string | null; onCancel: () => void; onSave: (t: string) => void }) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  return (
    <Dialog title="Rename note" onCancel={onCancel}>
      <form onSubmit={(e) => { e.preventDefault(); onSave(trimmed); }}>
        <label className="block text-body">
          Title
          <input className={field} value={value} maxLength={300} onChange={(e) => setValue(e.target.value)} />
        </label>
        <Footer busy={busy} error={error} label="Save" onCancel={onCancel} disabled={!trimmed || trimmed === initial} />
      </form>
    </Dialog>
  );
}

function EditSummaryDialog({ summary, busy, error, onCancel, onSave }: { summary: Summary; busy: boolean; error: string | null; onCancel: () => void; onSave: (s: { gist: string; actionItems: string[]; keyDecisions: string[] }) => void }) {
  const [gist, setGist] = useState(summary.gist);
  const [actions, setActions] = useState(summary.actionItems.map((a) => a.text).join('\n'));
  const [decisions, setDecisions] = useState(summary.keyDecisions.map((d) => d.text).join('\n'));
  return (
    <Dialog title="Edit summary" onCancel={onCancel}>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ gist: gist.trim(), actionItems: lines(actions), keyDecisions: lines(decisions) }); }}>
        <label className="block text-body">
          Summary
          <textarea className={`${field} min-h-32`} value={gist} maxLength={20000} onChange={(e) => setGist(e.target.value)} />
        </label>
        <label className="mt-3 block text-body">
          Action items, one per line
          <textarea className={`${field} min-h-24`} value={actions} onChange={(e) => setActions(e.target.value)} />
        </label>
        <label className="mt-3 block text-body">
          Key decisions, one per line
          <textarea className={`${field} min-h-24`} value={decisions} onChange={(e) => setDecisions(e.target.value)} />
        </label>
        <Footer busy={busy} error={error} label="Save" onCancel={onCancel} disabled={!gist.trim()} />
      </form>
    </Dialog>
  );
}

function RegenerateDialog({ busy, error, onCancel, onRegenerate }: { busy: boolean; error: string | null; onCancel: () => void; onRegenerate: (template: (typeof SUMMARY_TEMPLATES)[number]['id'], confirmOverwrite: boolean) => void }) {
  const [template, setTemplate] = useState<(typeof SUMMARY_TEMPLATES)[number]['id']>('general');
  const [overwrite, setOverwrite] = useState(false);
  return (
    <Dialog title="Regenerate summary" onCancel={onCancel}>
      <form onSubmit={(e) => { e.preventDefault(); onRegenerate(template, overwrite); }}>
        <fieldset>
          <legend className="mb-2 text-body">Summarise it as</legend>
          <div className="flex flex-col gap-2">
            {SUMMARY_TEMPLATES.map((t) => (
              <label key={t.id} className="flex gap-2 text-body">
                <input type="radio" name="template" value={t.id} checked={template === t.id} onChange={() => setTemplate(t.id)} />
                <span><span className="font-semibold text-heading">{t.label}</span> <span className="text-muted">{t.blurb}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="mt-4 flex gap-2 text-body">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          Replace my edits, if I edited this summary
        </label>
        <Footer busy={busy} error={error} label="Regenerate" onCancel={onCancel} />
      </form>
    </Dialog>
  );
}

function FeedbackDialog({ busy, error, onCancel, onSend }: { busy: boolean; error: string | null; onCancel: () => void; onSend: (kind: 'summary' | 'transcription', rating: number, comment: string) => void }) {
  const [kind, setKind] = useState<'summary' | 'transcription'>('summary');
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  return (
    <Dialog title="Rate this note" onCancel={onCancel}>
      <form onSubmit={(e) => { e.preventDefault(); onSend(kind, rating, comment.trim()); }}>
        <label className="block text-body">
          What are you rating?
          <select className={field} value={kind} onChange={(e) => setKind(e.target.value as 'summary' | 'transcription')}>
            <option value="summary">The summary</option>
            <option value="transcription">The transcript</option>
          </select>
        </label>
        <fieldset className="mt-3">
          <legend className="text-body">Rating</legend>
          <div className="mt-1 flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" aria-pressed={rating === n} aria-label={`${n} out of 5`} className={`h-10 w-10 rounded-lg border ${rating >= n ? 'border-accent bg-accent/20' : 'border-border'}`} onClick={() => setRating(n)}>
                {n}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="mt-3 block text-body">
          Anything to add? (optional; don’t include private details)
          <textarea className={`${field} min-h-20`} value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} />
        </label>
        <Footer busy={busy} error={error} label="Send" onCancel={onCancel} disabled={!rating} />
      </form>
    </Dialog>
  );
}

function ExportDialog({ busy, error, onCancel, onExport }: { busy: boolean; error: string | null; onCancel: () => void; onExport: (scope: 'summary' | 'transcript' | 'both') => void }) {
  const [scope, setScope] = useState<'summary' | 'transcript' | 'both'>('both');
  return (
    <Dialog title="Export as a Word document" onCancel={onCancel}>
      <form onSubmit={(e) => { e.preventDefault(); onExport(scope); }}>
        <label className="block text-body">
          Include
          <select className={field} value={scope} onChange={(e) => setScope(e.target.value as 'summary' | 'transcript' | 'both')}>
            <option value="both">Summary and transcript</option>
            <option value="summary">Summary only</option>
            <option value="transcript">Transcript only</option>
          </select>
        </label>
        <Footer busy={busy} error={error} label="Download" onCancel={onCancel} />
      </form>
    </Dialog>
  );
}
