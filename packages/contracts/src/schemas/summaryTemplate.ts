// The summary-template set — the prompt variant the summarizer uses.
//
// The ids are a wire contract with shared/summary-templates.cjs: the server
// falls back to `general` for an id it does not recognise, so a mismatch would
// silently ignore the user's choice rather than error. This module is the
// single source of truth for that id set and its client-facing labels.
//
// Source shapes:
//   - ids + `label` + `version`  ← shared/summary-templates.cjs (TEMPLATES)
//   - `blurb` + `icon`           ← ios-native/Wassup/Models/SummaryTemplate.swift
//     (SF Symbol name; the web renders its own glyph but the id/label/blurb
//      are shared).
import { z } from './zod';

/** The recognised template ids. Source: `templateIds()` in
 * shared/summary-templates.cjs (`general`, `clinical`, `actions_only`). */
export const SummaryTemplateId = z
  .enum(['general', 'clinical', 'actions_only'])
  .openapi('SummaryTemplateId');

/** The server's fallback when an id is unknown. Source: DEFAULT_TEMPLATE_ID. */
export const DEFAULT_SUMMARY_TEMPLATE_ID = 'general' as const;

/**
 * A client-facing template descriptor. `promptBody`/`responseSchema` from the
 * cjs are server-internal and deliberately excluded — a client never sees the
 * prompt text.
 */
export const SummaryTemplate = z
  .object({
    id: SummaryTemplateId,
    label: z.string(),
    blurb: z.string(),
    icon: z.string(), // SF Symbol name from the iOS model
    version: z.number().int(),
  })
  .openapi('SummaryTemplate');

/**
 * The template set as a shared constant, so all three clients render the same
 * picker. label/version come from shared/summary-templates.cjs; blurb/icon from
 * the iOS SummaryTemplate model.
 */
export const SUMMARY_TEMPLATES: ReadonlyArray<z.infer<typeof SummaryTemplate>> = [
  {
    id: 'general',
    label: 'General meeting',
    blurb: 'A balanced summary: overview, decisions and follow-ups.',
    icon: 'doc.text',
    version: 1,
  },
  {
    id: 'clinical',
    label: 'Clinical consult',
    blurb: 'Records only what was said. Never infers a diagnosis, dosage or treatment.',
    icon: 'stethoscope',
    version: 1,
  },
  {
    id: 'actions_only',
    label: 'Action items only',
    blurb: 'Just the commitments and follow-ups, with almost no discussion.',
    icon: 'checklist',
    version: 1,
  },
];

export type SummaryTemplateId = z.infer<typeof SummaryTemplateId>;
export type SummaryTemplate = z.infer<typeof SummaryTemplate>;
