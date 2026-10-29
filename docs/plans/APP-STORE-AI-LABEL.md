# Decision memo: a "written by AI" label

**Draft for the owner, 2026-10-29.** Checked against `origin/integration` at aa7a8e38. A plan, not legal
advice. It answers RELEASE.md "Status, 2026-10-27" decision 5 (default: **a "written by AI" label on
summaries**).

## Owner decision

- **Which option** (§3). Default: **C, in-app plus every export and share, landed before RC1.** An iOS change
  after RC1 restarts the 7-day crash-free clock (RELEASE.md Phase C).

## 1. What exists today [code]

**In the app, nothing on the summary says AI wrote it.**
- iOS summary card: eyebrow "Summary" only (`apps/ios/AlgoMinutes/Features/NoteDetail/SummaryPane.swift`);
  action items and decisions unlabelled.
- Web note page: heading "Summary" only (`apps/web/src/app/notes/NoteDetailPage.tsx`); the only footnote is
  about redaction.
- AI is named in: the recording sheet ("summarised by Google Cloud's speech and AI services",
  `RecorderFlow.swift`); the "Ask AI" button (`FilesView.swift`); one export scope, "AI Summary &
  Transcription" (`Models/ExportScope.swift`), where the other two say "Summary" and "Transcript".

**Exports and shares carry a redaction notice, never an AI notice**, and people who never saw the app read
them.
- PDF: title, "Summary", the redaction notice at the foot (`Services/PDFExporter.swift`).
- TXT: "EXECUTIVE SUMMARY", the notice at the end (`Models/ExportScope.swift`).
- DOCX (server-built, iOS and web): "Executive Summary", the notice in italics
  (`services/api/src/routes/export-note.cjs`).
- E-mail export: the body is only the redaction notice (`NoteDetailViewModel.swift`).
- Shared link page: "Shared from AlgoMinutes", then "Summary" (`apps/web/src/app/share/SharedNotePage.tsx`).

**The legal pages say it, to those who read them:** Privacy ("AI output can be wrong…"); Terms §6 "AI output".

**The listing leans the other way.** The name "AlgoMinutes: AI Meeting Notes" is fine. Screenshot 3's title
"Searchable, accurate transcript" (`docs/STORE-LISTING.md` §2) is an accuracy claim the Terms disclaim.

## 2. Obligations and risks

Sources were read on 2026-10-28. None of this is verified by counsel.

| # | Source | What it means for us | Certainty |
|---|---|---|---|
| 1 | Apple App Review Guidelines | No guideline requires an "AI-generated" label (the page was not read to the end). 5.1.2(i): clear disclosure and explicit permission before sharing personal data with third-party AI. 2.3/2.3.1: metadata must not mislead ("accurate transcript"). | High that no label is required; medium on "accurate" |
| 2 | EU AI Act Art. 50 (applies from 2 Aug 2026 as read) | 50(2): providers of systems generating text mark output machine-readably as AI-generated, unless the system "does not substantially alter the input data" (a summary probably does). 50(1): chat must be obviously AI ("Ask AI" is). 50(5): clear by first exposure. | Medium: whether we are the "provider", and the exemption, are open |
| 3 | AI Act "Digital Omnibus" (secondary sources) | Reported grace to 2 Dec 2026 for systems on the market before 2 Aug 2026; we launch after, so likely no help. | Low to medium; not the Official Journal |
| 4 | Australia: DISR/NAIC "Being clear about AI-generated content" (Nov 2025); Guidance for AI Adoption | Voluntary; recommends visible labels, watermarks or metadata, scaled to risk. | High that it is voluntary |
| 5 | Australian Consumer Law s18 | Binding; bites on accuracy claims in marketing more than on labels. | High that it applies; how is for counsel |
| 6 | Practice (Google Meet help; Zoom AI Companion as described by university guides) | Large vendors label AI output and say "check it", usually in help pages and summary e-mails. | Medium; in-product wording not verified; Otter, Granola, Fireflies not checked |

**The practical risk is not a regulator.** It is a colleague acting on a wrong action item in a forwarded PDF
with no sign that a model wrote it. Our Terms bind the user, not that reader.

## 3. Options

| Option | What | Effort | Trade-offs |
|---|---|---|---|
| A. None | Leave as is | 0 | Overrides the RELEASE.md default; nothing to show for Art. 50(2); exports read like human minutes |
| B. In-app only | One line under the summary on iOS and web | ~0.5 day, no contract change | Covers the user, who already agreed to the Terms; misses export and link readers |
| C. In-app plus every export and share | B, plus a line at the top of PDF, TXT, DOCX, the e-mail body, the shared page; and a machine-readable mark (PDF Keywords/Creator, DOCX core properties, a `<meta>` on the shared page) | ~1.5–2 days across iOS, web, `services/api`; copy only, no contract change | Best cover for third parties and Art. 50(2). Two copies to keep in sync (iOS `NoteExport` and `export-note.cjs` already duplicate the redaction notice). Extend the iOS test that the notice survives every scope, and the DOCX test |

## 4. Recommendation: C, before RC1

Plain, calm, at most 12 words, never icon-only. Keep the redaction notice as it is.

| Placement | Copy | Where |
|---|---|---|
| iOS summary card | "Written by AI from your recording. Check anything important." | `SummaryPane.swift`, under the gist |
| Web note page | "Written by AI from your recording. Check anything important." | `NoteDetailPage.tsx`, Summary section |
| PDF, TXT, DOCX (summary scopes) | "Summary, action items and decisions written by AI. May contain errors." | Under the title: `PDFExporter.swift`, `ExportScope.swift` `plainText`, `export-note.cjs` |
| Transcript-only exports | "Transcribed automatically. Words and speaker names may be wrong." | Same spot |
| E-mail export body | "These notes were written by AI from a recording. Check before relying." | Above the redaction notice, `NoteDetailViewModel.swift` |
| Shared link page | "Written by AI from a recording. It may contain mistakes." | Under "Shared from AlgoMinutes", `SharedNotePage.tsx` |
| Ask AI answers | "AI answers can be wrong. Check the transcript." | `AskAIComposer.swift`, and web chat |
| Machine-readable | `AI-generated (AlgoMinutes, Gemini)` | PDF Keywords/Creator, DOCX core `description`, `<meta name="generator">` on the shared page |

Also: rename the export scope "AI Summary & Transcription" to "Summary & transcript", so the three match; drop
"accurate" from screenshot 3 (`APP-STORE-REVIEW-PACKAGE.md` §3); add one line to the review notes
(`APP-STORE-REVIEW-PACKAGE.md` §1).

Later, not 1.0: once a user edits a summary, "Written by AI" is half true. The server already tracks manual
edits (`editedAt`, `packages/contracts/src/schemas/actions.ts`); "Written by AI, edited by you" would touch the
contract (a three-client change).

## 5. For counsel (also in `APP-STORE-LEGAL.md` §4.6)

1. Are we a "provider" under Art. 50(2) when Google provides the model? Does "does not substantially alter the
   input data" cover meeting summaries?
2. The final Omnibus text and dates; any transition for an app first placed on the EU market after 2 Aug 2026?
3. Is a visible line plus document metadata enough machine-readable marking for text?
4. Liability to recipients of an export or link: is the line enough, or should it link to Terms §6?
5. ACL s18 and Apple 2.3: "accurate", "instant" and "AI Meeting Notes" in the listing (with the `TODO(legal)` in
   `STORE-LISTING.md`).
6. Does the sheet's wording (`RecorderFlow.swift`) meet Apple 5.1.2(i)'s "explicit permission" for third-party
   AI? (`APP-STORE-REVIEW-PACKAGE.md`, owner decisions.)

## Not verified

Every row of §2 (secondary reading, not counsel); competitors' in-product wording; the effort estimates.
