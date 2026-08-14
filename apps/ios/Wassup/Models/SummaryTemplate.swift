import Foundation

/// Which prompt the summarizer uses.
///
/// The `rawValue`s are a wire contract with `shared/summary-templates.cjs`.
/// The server falls back to `general` for an id it does not recognise rather
/// than failing the job — so a mismatch here would not error anywhere, it
/// would quietly ignore the user's choice and hand back a general summary.
/// `SummaryTemplateTests` pins the ids for exactly that reason.
enum SummaryTemplate: String, CaseIterable, Identifiable, Sendable {
    case general
    case clinical
    case actionsOnly = "actions_only"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .general: return "General meeting"
        case .clinical: return "Clinical consult"
        case .actionsOnly: return "Action items only"
        }
    }

    /// One line, in the user's terms — what changes about the summary, not
    /// how the prompt is written.
    var blurb: String {
        switch self {
        case .general:
            return "A balanced summary: overview, decisions and follow-ups."
        case .clinical:
            return "Records only what was said. Never infers a diagnosis, dosage or treatment."
        case .actionsOnly:
            return "Just the commitments and follow-ups, with almost no discussion."
        }
    }

    var icon: String {
        switch self {
        case .general: return "doc.text"
        case .clinical: return "stethoscope"
        case .actionsOnly: return "checklist"
        }
    }
}
