import SwiftUI
import MessageUI

/// Emails an exported file through the user's own mail account.
///
/// This is why "export to email" needs no backend: no SendGrid or SES, no
/// deliverability surface to own, no new secret, and the note never passes
/// through a third party — the message is composed on-device and sent by
/// whichever account Mail is already configured with.
struct MailComposeSheet: UIViewControllerRepresentable {
    let subject: String
    let body: String
    let attachment: Data
    let fileName: String
    let mimeType: String
    let onFinish: () -> Void

    /// False on a device with no mail account configured, where presenting
    /// the composer shows an empty modal the user cannot escape.
    static var canSend: Bool { MFMailComposeViewController.canSendMail() }

    func makeUIViewController(context: Context) -> MFMailComposeViewController {
        let vc = MFMailComposeViewController()
        vc.mailComposeDelegate = context.coordinator
        vc.setSubject(subject)
        vc.setMessageBody(body, isHTML: false)
        vc.addAttachmentData(attachment, mimeType: mimeType, fileName: fileName)
        return vc
    }

    func updateUIViewController(_ vc: MFMailComposeViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, MFMailComposeViewControllerDelegate {
        private let onFinish: () -> Void
        init(onFinish: @escaping () -> Void) { self.onFinish = onFinish }

        func mailComposeController(
            _ controller: MFMailComposeViewController,
            didFinishWith result: MFMailComposeResult,
            error: Error?
        ) {
            if let error { AppLog.error("mail_compose_failed: \(error)") }
            onFinish()
        }
    }
}
