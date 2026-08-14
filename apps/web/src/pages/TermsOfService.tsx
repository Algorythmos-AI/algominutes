import type { CSSProperties } from 'react';
import { ChevronLeft } from 'lucide-react';

interface Props {
  onBack?: () => void;
}

const LAST_UPDATED = '13 August 2026';
const CONTACT_EMAIL = 'skalaliya@gmail.com';

export default function TermsOfService({ onBack }: Props) {
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
          Terms of Service
        </h1>
        <p style={{ color: '#8C8684', fontSize: '0.85rem', marginBottom: '2rem' }}>
          Last updated: {LAST_UPDATED}
        </p>

        <div className="space-y-6" style={{ fontSize: '0.92rem', lineHeight: 1.65 }}>
          <section>
            <h2 style={sectionHeading}>1. Agreement</h2>
            <p>
              By signing in to Wassup Doc you agree to these Terms and to our{' '}
              <a href="/privacy" style={{ color: '#FFFFFF', textDecoration: 'underline' }}>
                Privacy Policy
              </a>
              . If you do not agree, do not use the service.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>2. Clinical alpha</h2>
            <p>
              Wassup Doc is in clinical alpha. The service is provided to a small number of
              testers for evaluation. Features may change, downtime is possible, and the
              service should not be used as the sole record for clinical, legal, or
              financial purposes during this period.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>3. Your account</h2>
            <p>
              You must sign in with a valid Google or Apple account that you control.
              You are responsible for activity on your account and for keeping your
              sign-in credentials secure.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>4. Recording responsibilities</h2>
            <p>
              You may only record conversations you are entitled to record. If others
              are present, you must inform them and obtain their consent in any
              jurisdiction that requires it. Wassup Doc is not responsible for recordings
              made without proper consent.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>5. Acceptable use</h2>
            <ul style={listStyle}>
              <li>Do not use the service to record people without their knowledge in jurisdictions that require their consent.</li>
              <li>Do not use the service to harass, defame, or harm others.</li>
              <li>Do not attempt to reverse engineer, scrape, or bypass authentication on the service.</li>
              <li>Do not upload malware, illegal content, or content that infringes someone else&rsquo;s rights.</li>
            </ul>
          </section>

          <section>
            <h2 style={sectionHeading}>6. Your content</h2>
            <p>
              You keep ownership of your recordings, transcripts, summaries, and any
              text you provide to the chat or search features. You grant us a limited
              licence to process this content solely to operate the service for you
              (transcription, summarization, embedding, search, retrieval). We do not
              use your content to train general AI models.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>7. Sharing notes</h2>
            <p>
              The service lets you create a link that gives anyone holding it read
              access to one note, without signing in. You choose when to create such a
              link, how long it lasts, and when to revoke it.
            </p>
            <p>
              <strong>You are responsible for who receives a share link and what they
              do with it.</strong> A link is a public credential: it carries no password
              and cannot tell one recipient from another. Once you send it, you cannot
              control onward forwarding. Where a recording involves other people,
              sharing it is subject to the same consent obligations as making it
              (section 4), and where it contains health information you remain
              responsible for the disclosure under whatever rules apply to you.
            </p>
            <p>
              We provide expiry, revocation, PII masking and search-engine exclusion as
              safeguards. They reduce risk; they do not remove it, and they are not a
              substitute for judgement about what to share and with whom.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>8. Termination</h2>
            <p>
              You can delete your account at any time from Settings &rarr; Delete my
              account. Deletion is final and triggers permanent removal of your data
              across our systems within ordinary backup retention windows. We may
              suspend or terminate accounts that violate these Terms.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>9. Service &ldquo;as is&rdquo;</h2>
            <p>
              Wassup Doc is provided on an as-is basis. To the extent permitted by law, we
              disclaim all warranties, express or implied, including merchantability,
              fitness for a particular purpose, and non-infringement. We do not warrant
              that transcripts or summaries are accurate, complete, or suitable for any
              specific purpose. Verify anything you rely on.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>10. Limitation of liability</h2>
            <p>
              To the maximum extent permitted by law, Wassup Doc and its operator are not
              liable for indirect, incidental, special, consequential, or punitive
              damages, or for loss of profits, revenue, data, or goodwill. Our total
              liability for any claim arising from the service is limited to the amount
              you paid us in the twelve months preceding the claim, or AUD 100,
              whichever is greater.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>11. Governing law</h2>
            <p>
              These Terms are governed by the laws of New South Wales, Australia.
              Disputes will be resolved in the courts of New South Wales unless
              applicable consumer law gives you the right to bring a claim where you
              live.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>12. Changes</h2>
            <p>
              We may update these Terms as the service evolves. Material changes will
              be surfaced inside the app before they take effect.
            </p>
          </section>

          <section>
            <h2 style={sectionHeading}>13. Contact</h2>
            <p>
              Questions or notices:{' '}
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
