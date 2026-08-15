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
    case actionsOnly = "actions_only"
    case standup
    case interview
    case salesCall = "sales_call"
    case lecture
    case oneOnOne = "one_on_one"
    case boardMeeting = "board_meeting"
    case clientMeeting = "client_meeting"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .general: return "General meeting"
        case .actionsOnly: return "Action items only"
        case .standup: return "Standup"
        case .interview: return "Interview"
        case .salesCall: return "Sales call"
        case .lecture: return "Lecture"
        case .oneOnOne: return "One-on-one"
        case .boardMeeting: return "Board meeting"
        case .clientMeeting: return "Client meeting"
        }
    }

    /// One line, in the user's terms — what changes about the summary, not
    /// how the prompt is written.
    var blurb: String {
        switch self {
        case .general:
            return "A balanced summary: overview, decisions and follow-ups."
        case .actionsOnly:
            return "Just the commitments and follow-ups, with almost no discussion."
        case .standup:
            return "Blockers, progress and each person's next steps."
        case .interview:
            return "Candidate signals, answers and follow-ups to check."
        case .salesCall:
            return "Needs, objections, next steps and the deal state."
        case .lecture:
            return "Key points and takeaways, structured for study."
        case .oneOnOne:
            return "Discussion, feedback and agreed follow-ups."
        case .boardMeeting:
            return "Resolutions, approvals and action owners."
        case .clientMeeting:
            return "Requests, commitments and next steps with the client."
        }
    }

    var icon: String {
        switch self {
        case .general: return "doc.text"
        case .actionsOnly: return "checklist"
        case .standup: return "person.3"
        case .interview: return "quote.bubble"
        case .salesCall: return "dollarsign.circle"
        case .lecture: return "graduationcap"
        case .oneOnOne: return "person.2"
        case .boardMeeting: return "building.columns"
        case .clientMeeting: return "briefcase"
        }
    }
}
