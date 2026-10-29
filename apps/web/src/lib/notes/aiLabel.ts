/**
 * Who wrote what, said wherever a note is read (docs/plans/APP-STORE-AI-LABEL.md, option C). Mirrors the
 * iOS copy in apps/ios/AlgoMinutes/Models/ExportScope.swift (NoteExport) and the DOCX export in
 * services/api/src/routes/export-note.cjs.
 */
export const AI_IN_APP_NOTICE = 'Written by Algorythmos AI from your recording. Check anything important.';
export const AI_SHARED_NOTICE = 'Written by Algorythmos AI from a recording. It may contain mistakes.';
/** Machine-readable mark (EU AI Act Art. 50(2)): the shared page's generator meta. */
export const AI_MACHINE_MARK = 'AI-generated (Algorythmos AI: Google Gemini and Speech-to-Text)';
