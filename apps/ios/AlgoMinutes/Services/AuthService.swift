import AuthenticationServices
import CryptoKit
import FirebaseAuth
import FirebaseFirestore
import Foundation
import GoogleSignIn
import UIKit

/// Firebase Auth with Sign in with Apple + Google — parity with `handleLogin`
/// in `src/App.tsx` (native path).
@Observable
@MainActor
final class AuthService: NSObject {
    private(set) var user: User?
    private(set) var isSigningIn = false
    var authError: String?

    var workspaceId: String? { user.map { AlgoMinutes.workspaceId(forUid: $0.uid) } }

    private var authListener: AuthStateDidChangeListenerHandle?
    private var currentNonce: String?
    private var appleContinuation: CheckedContinuation<ASAuthorization, Error>?

    override init() {
        super.init()
        authListener = Auth.auth().addStateDidChangeListener { [weak self] _, user in
            Task { @MainActor in
                self?.user = user
                if user != nil {
                    await self?.ensureWorkspaceDoc()
                }
            }
        }
    }

    // MARK: - Google

    func signInWithGoogle() async {
        guard !isSigningIn else { return }
        isSigningIn = true
        defer { isSigningIn = false }
        authError = nil
        do {
            guard let rootVC = Self.presentingViewController() else { return }
            let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: rootVC)
            guard let idToken = result.user.idToken?.tokenString else {
                throw APIError.invalidResponse
            }
            let credential = GoogleAuthProvider.credential(
                withIDToken: idToken,
                accessToken: result.user.accessToken.tokenString
            )
            try await Auth.auth().signIn(with: credential)
        } catch is CancellationError {
            // user cancelled — no error surface
        } catch let error as NSError where error.code == GIDSignInError.canceled.rawValue {
            // user cancelled — no error surface
        } catch {
            authError = "Sign-in failed. Please try again."
        }
    }

    // MARK: - Apple

    func signInWithApple() async {
        guard !isSigningIn else { return }
        isSigningIn = true
        defer { isSigningIn = false }
        authError = nil

        let nonce = Self.randomNonce()
        currentNonce = nonce

        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = Self.sha256(nonce)

        do {
            let authorization = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<ASAuthorization, Error>) in
                appleContinuation = cont
                let controller = ASAuthorizationController(authorizationRequests: [request])
                controller.delegate = self
                controller.presentationContextProvider = self
                controller.performRequests()
            }
            guard let appleCredential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = appleCredential.identityToken,
                  let idToken = String(data: tokenData, encoding: .utf8) else {
                throw APIError.invalidResponse
            }
            let credential = OAuthProvider.appleCredential(
                withIDToken: idToken,
                rawNonce: nonce,
                fullName: appleCredential.fullName
            )
            try await Auth.auth().signIn(with: credential)
        } catch let error as ASAuthorizationError where error.code == .canceled {
            // user cancelled — no error surface
        } catch {
            authError = "Sign-in failed. Please try again."
        }
    }

    /// Configures the request from the native `SignInWithAppleButton` — sets
    /// scopes and the hashed nonce (raw nonce stashed for the credential).
    func prepareAppleRequest(_ request: ASAuthorizationAppleIDRequest) {
        let nonce = Self.randomNonce()
        currentNonce = nonce
        request.requestedScopes = [.fullName, .email]
        request.nonce = Self.sha256(nonce)
    }

    /// Handles the native `SignInWithAppleButton` completion, exchanging the
    /// Apple credential for a Firebase sign-in using the stashed raw nonce.
    func completeAppleSignIn(_ result: Result<ASAuthorization, Error>) async {
        guard !isSigningIn else { return }
        isSigningIn = true
        defer { isSigningIn = false }
        authError = nil

        switch result {
        case .failure(let error):
            if let asError = error as? ASAuthorizationError, asError.code == .canceled { return }
            authError = "Sign-in failed. Please try again."
        case .success(let authorization):
            guard let appleCredential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let nonce = currentNonce,
                  let tokenData = appleCredential.identityToken,
                  let idToken = String(data: tokenData, encoding: .utf8) else {
                authError = "Sign-in failed. Please try again."
                return
            }
            let credential = OAuthProvider.appleCredential(
                withIDToken: idToken, rawNonce: nonce, fullName: appleCredential.fullName
            )
            do {
                try await Auth.auth().signIn(with: credential)
            } catch {
                authError = "Sign-in failed. Please try again."
            }
        }
    }

    #if DEBUG
    /// Local-development only: sign in anonymously so the app has a real
    /// Firebase UID + ID token (Firestore listeners and `/api` calls
    /// authenticate) without an Apple/Google flow that can't complete in a
    /// bare simulator. Compiled out of Release builds — never ships.
    /// Requires the Anonymous provider to be enabled in Firebase Auth.
    func signInAsDevGuest() async {
        guard !isSigningIn else { return }
        isSigningIn = true
        defer { isSigningIn = false }
        authError = nil
        do {
            try await Auth.auth().signInAnonymously()
        } catch {
            authError = "Dev sign-in failed — enable the Anonymous provider in Firebase Auth. (\(error.localizedDescription))"
        }
    }
    #endif

    // MARK: - Session

    func signOut() {
        do {
            try Auth.auth().signOut()
            // Also clear the Google session so the next sign-in starts fresh.
            GIDSignIn.sharedInstance.signOut()
        } catch {
            authError = "Could not sign out. Please try again."
        }
    }

    /// Parity with the web app: ensure `workspaces/{wsId}` exists at sign-in.
    private func ensureWorkspaceDoc() async {
        guard let user, let wsId = workspaceId else { return }
        let ref = Firestore.firestore().collection("workspaces").document(wsId)
        do {
            let snapshot = try await ref.getDocument()
            if !snapshot.exists {
                try await ref.setData([
                    "name": "My Workspace",
                    "ownerId": user.uid,
                    "members": [user.uid],
                ])
            }
        } catch {
            // Non-fatal: backend also validates workspace on every call.
        }
    }

    // MARK: - Helpers

    static func presentingViewController() -> UIViewController? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }?
            .rootViewController
    }

    /// Cryptographically random nonce for the Apple sign-in request.
    ///
    /// The rejection bound is computed in `Int`, deliberately. It used to read
    /// `UInt8(charset.count * (256 / charset.count))`, and this charset is 64
    /// characters, so that expression evaluates to exactly 256 — one past what
    /// a `UInt8` can hold. The initialiser trapped on the first byte, meaning
    /// the app died the instant anyone tapped Sign in with Apple. Every time,
    /// on every device; it survived to TestFlight only because testing until
    /// now went through Google.
    private static func randomNonce(length: Int = 32) -> String {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        // Discard bytes in the short tail so every character stays equally
        // likely. 256 % 64 == 0, so nothing is discarded today — the expression
        // is here to stay correct if the charset ever changes size.
        let limit = 256 - (256 % charset.count)
        var result = ""
        result.reserveCapacity(length)
        while result.count < length {
            var byte: UInt8 = 0
            let status = SecRandomCopyBytes(kSecRandomDefault, 1, &byte)
            // A failure here must not spin the loop forever, which is what
            // retrying-until-success would do if the generator were unavailable.
            // SystemRandomNumberGenerator is backed by arc4random_buf on Apple
            // platforms, so the fallback is still cryptographically secure.
            let value = status == errSecSuccess ? Int(byte) : Int(UInt8.random(in: 0...255))
            if value < limit {
                result.append(charset[value % charset.count])
            }
        }
        return result
    }

    private static func sha256(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }
}

extension AuthService: ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        appleContinuation?.resume(returning: authorization)
        appleContinuation = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        appleContinuation?.resume(throwing: error)
        appleContinuation = nil
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        Self.presentingViewController()?.view.window ?? ASPresentationAnchor()
    }
}
