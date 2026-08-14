import type { CSSProperties } from 'react';
import { ChevronLeft } from 'lucide-react';

interface Props {
  onBack?: () => void;
}

const LAST_UPDATED = '13 August 2026';
const CONTACT_EMAIL = 'skalaliya@gmail.com';

export default function PrivacyPolicy({ onBack }: Props) {
  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = '/';
    }
  };

  return (
    <div
      className="min-h-screen overflow-y-auto"
      style={{
        background: 'linear-gradient(180deg,#050505,#0a0a0a 40%,#050505)',
        color: '#E5E0DF',
        fontFamily: 'Titillium Web, sans-serif',
        paddingTop: 'calc(env(safe-area-inset-top, 0px))',
        paddingBottom: 'calc(2rem + env(safe-area-inset-bottom, 0px))',
      }}
    >
      <div className="max-w-2xl mx-auto px-6 pt-6">
        <button
          onClick={handleBack}
          className="flex items-center gap-1 mb-6 px-2 py-1 -ml-2 rounded-md"
          style={{ color: '#FFFFFF', fontFamily: 'Rajdhani, sans-serif', fontSize: '0.95rem', fontWeight: 600 }}
          aria-label="Back"
        >
          <ChevronLeft size={20} />
          Back
        </button>

        <h1
          style={{
            fontFamily: 'Rajdhani, sans-serif',
            fontWeight: 800,
            fontSize: '2rem',
            color: '#FFFFFF',
            marginBottom: '0.5rem',
          }}
        >
          Privacy Policy
        </h1>
        <p style={{ color: '#8C8684', fontSize: '0.85rem', marginBottom: '2rem' }}>
          Last updated: {LAST_UPDATED}
        </p>

        <div className="space-y-6" style={{ fontSize: '0.92rem', lineHeight: 1.65 }}>
          <section>
            <h2 style={sectionHeading}>1. Who we are</h2>
            <p>
              Wassup Doc is a personal meeting and document assistant. This policy describes
              what we collect, how we use it, where we store it, who we share it with,
              and how you can delete it.
            </p>
            <p>
              Wassup Doc is currently in clinical alpha for a small number of testers. The
              service is operated by the developer; contact details are at the bottom of
              this page.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>2. What we collect</h2>
            <ul style={listStyle}>
              <li>
                <strong>Account data:</strong> the email address you sign in with via
                Google or Apple, and a Firebase user ID derived from it.
              </li>
              <li>
                <strong>Recordings:</strong> audio files you record or upload. These are
                only created when you tap a record button or choose a file to import.
              </li>
              <li>
                <strong>Transcripts and summaries:</strong> the text we produce from your
                recordings, including any action items extracted by the summarizer.
              </li>
              <li>
                <strong>Search and chat content:</strong> the questions you ask the
                in-app search and chat features, and the chunks retrieved to answer
                them.
              </li>
              <li>
                <strong>Quality ratings:</strong> the star rating you give a
                transcription, and any note you add with it. Ratings are tied to your
                user ID. Free-text comments are PII-scrubbed before they are stored.
              </li>
              <li>
                <strong>Diagnostic logs:</strong> errors and timing data tagged with your
                user ID and a per-request trace ID, used to debug processing failures.
              </li>
            </ul>
            <p>
              We do not collect location, contacts, advertising identifiers, or any data
              from outside the app.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>3. Where it is stored</h2>
            <p>
              All data is stored in Google Cloud Platform regions in the United States
              (primarily <code style={codeStyle}>us-central1</code>). Specifically:
            </p>
            <ul style={listStyle}>
              <li>
                <strong>Audio files</strong> live in a private Google Cloud Storage
                bucket; no public links are created.
              </li>
              <li>
                <strong>Transcripts, summaries, embeddings, and search chunks</strong>{' '}
                live in a private Cloud SQL Postgres database with vector indexing.
              </li>
              <li>
                <strong>Note metadata</strong> (titles, status, timestamps) is cached in
                Firestore for low-latency UI updates. Postgres is the source of truth.
              </li>
              <li>
                <strong>Authentication state</strong> is managed by Firebase Auth.
              </li>
            </ul>
          </section>

          <section>
            <h2 style={sectionHeading}>4. Third parties we use</h2>
            <p>
              We use Google Cloud and Firebase for hosting, authentication, and storage.
              We use Google&rsquo;s Vertex AI service (Gemini models) for speech-to-text
              transcription, summarization, and text embeddings. These are sub-processors
              under Google Cloud terms; data sent to them is governed by your project
              configuration and is not used to train Google&rsquo;s general models.
            </p>
            <p>
              Before any transcript text is sent to Vertex AI for summarization, chat,
              or embedding, we run a redaction step that replaces recognisable
              identifiers with placeholder tags: Medicare and IHI numbers, credit card
              numbers, email addresses, phone numbers, bank account numbers and
              government identification numbers. The redaction layer is applied at the
              application boundary, before the request leaves our backend.
            </p>
            <p>
              This redaction works on patterns, so it does not remove everything that
              could identify someone. In particular, <strong>names, dates of birth and
              addresses spoken aloud in a recording are not removed</strong>, and they are
              stored with the transcript and included in what is sent to Vertex AI. If
              you need those removed as well, edit the transcript or summary after
              processing, or avoid saying them during a recording.
            </p>
            <p>
              We do not sell data, share it with advertisers, or send it to analytics
              providers.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>5. How long we keep it</h2>
            <p>
              We keep your data until you delete it. There is no automatic retention
              cutoff. You can:
            </p>
            <ul style={listStyle}>
              <li>Delete an individual note from inside the app (deletes audio, transcript, summary, and search index entries).</li>
              <li>Delete your entire account from Settings &rarr; Delete my account (deletes all of the above plus your account row and authentication record).</li>
            </ul>
            <p>
              Account deletion is a one-way operation and triggers a cascade across
              Firestore, Postgres, and Google Cloud Storage. Backups taken before the
              deletion may persist for up to 30 days as part of standard disaster
              recovery, after which they are overwritten.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>6. Your rights</h2>
            <p>
              Depending on your location you have rights under GDPR (EU/UK), the
              Australian Privacy Principles, and other regimes. These include the right
              to access your data, correct it, export it, delete it, and complain to a
              regulator. The in-app account deletion satisfies the right to erasure
              (GDPR Article 17). For other requests, email us at the address below and
              we will respond within 30 days.
            </p>
            <p>
              <strong>California residents (CCPA / CPRA):</strong> you have the right
              to know what personal information we collect, to delete it, to correct
              it, and to opt out of sale or sharing. We do not sell or share personal
              information, and we do not use it for cross-context behavioural
              advertising. The in-app account deletion satisfies the right to delete.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>7. Recording consent</h2>
            <p>
              You are responsible for ensuring everyone whose voice may be captured has
              consented to the recording. Two-party consent jurisdictions (parts of the
              United States, much of the European Union) require explicit consent from
              all participants. The app prompts you for this acknowledgement before each
              recording starts, but the legal responsibility is yours.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>8. Sharing a note by link</h2>
            <p>
              You can create a link that lets someone read one of your notes without
              signing in. This is off by default and only happens when you create a link
              yourself.
            </p>
            <p>
              <strong>A share link is public.</strong> Anyone who has it can open the
              note — there is no password and no sign-in. Treat it like the contents of
              the note itself: if the link is forwarded, so is the note. Send it only
              over a channel you trust.
            </p>
            <ul style={listStyle}>
              <li>
                <strong>Text only.</strong> A shared page shows the summary and
                transcript. The audio recording is never shared.
              </li>
              <li>
                <strong>It expires.</strong> Links stop working after the period you
                choose, seven days by default and thirty days at most.
              </li>
              <li>
                <strong>You can revoke it at any time</strong>, which takes effect
                immediately. Deleting the note also revokes every link to it.
              </li>
              <li>
                <strong>Detected card numbers, IDs and contact details are masked</strong>{' '}
                on shared pages, as they are everywhere else in the app.
              </li>
              <li>
                <strong>Shared pages are not indexed.</strong> We ask search engines not
                to crawl or list them, and they are never cached by a CDN.
              </li>
              <li>
                <strong>We record when a link is created, read, and revoked</strong>,
                so you can see whether a link has been opened.
              </li>
            </ul>
            <p>
              Deciding to share a note is yours to make. Where the recording involves
              other people, sharing it is subject to the same consent obligations as
              making it — see Recording consent above.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>9. Children</h2>
            <p>
              Wassup Doc is not directed at children under 13 (or under 16 in the EU/UK) and
              we do not knowingly collect their data. If you believe a child has
              registered, contact us and we will delete the account.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>10. Changes to this policy</h2>
            <p>
              We may update this policy as the service evolves. Material changes will be
              announced inside the app before they take effect. The Last Updated date at
              the top of this page reflects the most recent revision.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>11. Contact</h2>
            <p>
              Questions, deletion requests, or complaints:{' '}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                style={{ color: '#FFFFFF', textDecoration: 'underline' }}
              >
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

const sectionHeading: CSSProperties = {
  fontFamily: 'Rajdhani, sans-serif',
  fontWeight: 700,
  fontSize: '1.05rem',
  color: '#FFFFFF',
  marginBottom: '0.5rem',
};

const listStyle: CSSProperties = {
  listStyleType: 'disc',
  paddingLeft: '1.25rem',
  marginTop: '0.5rem',
  marginBottom: '0.75rem',
};

const codeStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(78,78,78,0.45)',
  borderRadius: '4px',
  padding: '1px 6px',
  fontSize: '0.85rem',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};
