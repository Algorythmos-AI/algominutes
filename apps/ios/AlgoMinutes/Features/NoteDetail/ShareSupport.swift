import SwiftUI

/// A payload for the system share sheet. `Identifiable` so it can drive
/// `.sheet(item:)` — presenting on a non-nil value rather than a separate
/// boolean keeps the items and the presentation state impossible to
/// desynchronise.
struct ShareItem: Identifiable {
    let id = UUID()
    let items: [Any]
}

struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
