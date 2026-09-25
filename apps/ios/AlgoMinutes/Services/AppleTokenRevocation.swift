import AuthenticationServices
import FirebaseAuth
import UIKit

/// Revokes the account's Sign in with Apple tokens, which Apple requires when
/// an account that uses Sign in with Apple is deleted (App Review 5.1.1(v)).
///
/// Firebase revokes them given a fresh authorization code, and only a new Apple
/// prompt yields one, so deleting an Apple-linked account asks the user to
/// confirm with Apple first. The Firebase project's Apple provider must be
/// configured (Services ID, Key ID and private key) for the revocation to work.
@MainActor
final class AppleTokenRevocation: NSObject {
    enum Outcome: Equatable {
        /// The account has no Apple sign-in: nothing to revoke.
        case notLinked
        case revoked
        /// The user dismissed Apple's prompt: the caller should not delete.
        case cancelled
    }

    private var continuation: CheckedContinuation<ASAuthorization, Error>?

    /// Whether any of the account's providers is Apple's.
    nonisolated static func isAppleLinked(providerIDs: [String]) -> Bool {
        providerIDs.contains("apple.com")
    }

    /// Prompts for Apple's confirmation and revokes the tokens. Throws when the
    /// revocation itself fails (the caller decides whether to delete anyway).
    func revokeIfLinked() async throws -> Outcome {
        guard let user = Auth.auth().currentUser,
              Self.isAppleLinked(providerIDs: user.providerData.map(\.providerID))
        else { return .notLinked }

        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [] // only the authorization code is needed
        let authorization: ASAuthorization
        do {
            authorization = try await withCheckedThrowingContinuation { cont in
                continuation = cont
                let controller = ASAuthorizationController(authorizationRequests: [request])
                controller.delegate = self
                controller.presentationContextProvider = self
                controller.performRequests()
            }
        } catch let error as ASAuthorizationError where error.code == .canceled {
            return .cancelled
        }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let codeData = credential.authorizationCode,
              let code = String(data: codeData, encoding: .utf8)
        else { throw APIError.invalidResponse }
        try await Auth.auth().revokeToken(withAuthorizationCode: code)
        return .revoked
    }
}

extension AppleTokenRevocation: ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        MainActor.assumeIsolated {
            continuation?.resume(returning: authorization)
            continuation = nil
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        MainActor.assumeIsolated {
            continuation?.resume(throwing: error)
            continuation = nil
        }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first { $0.isKeyWindow } ?? ASPresentationAnchor()
        }
    }
}
