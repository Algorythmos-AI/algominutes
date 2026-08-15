'use strict';

/**
 * PII / secret redaction for transcript text *before* it goes into Gemini
 * summarization, embeddings, or persistent storage. The audio bytes are
 * not redacted — that limitation is documented in the consent UI.
 *
 * Tags are kept short and uniform so the LLM understands a value was
 * removed without leaking the value itself.
 */

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const AWS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_\-]{35}\b/g;
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]+?-----END [^-]+PRIVATE KEY-----/g;
const JWT = /\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g;
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

// Credential shapes beyond AWS/Google. Bug 21 left "does redactPII cover cloud
// credentials?" open after an AWS secret survived a fixture; AWS_KEY above
// matches the access-key ID only, never the secret. A credential spoken aloud
// or pasted into a note is a live secret, and these are cheap, high-precision
// patterns with effectively no false-positive risk in ordinary prose.
const GITHUB_TOKEN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g;
const GITHUB_PAT = /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g;
const STRIPE_KEY = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g;
const OPENAI_KEY = /\bsk-(?:proj-)?[A-Za-z0-9_\-]{20,}\b/g;
// A connection URI carries the password inline: postgres://user:pass@host/db.
// Only the credential portion is replaced so the shape stays readable.
const URI_CREDENTIALS = /\b([a-z][a-z0-9+.\-]*:\/\/)[^\s:@/]+:[^\s:@/]+@/gi;

// Standard email shape. Matches RFC-ish addresses without trying to be perfect;
// over-redacting is safer than under-redacting per CLAUDE.md §2.
const EMAIL = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;

// IBAN: 2 letters + 2 digits + 11-30 alphanumeric. Apply BEFORE card_candidate
// so we don't double-redact (IBANs can contain Luhn-valid digit sequences).
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

// IHI (Individual Healthcare Identifier, AU): 16 digits starting with 8003.
// Apply BEFORE generic phone shapes — most specific wins.
const IHI = /\b8003[ ]?\d{4}[ ]?\d{4}[ ]?\d{4}\b/g;

// Medicare card number (AU): the first digit is 2-6 per Services Australia
// spec (https://www.servicesaustralia.gov.au/medicare-numbers). Without
// that constraint a 10-digit phone like 0412345678 false-matches and
// gets labelled MEDICARE. Format is XXXX XXXXX X, with an optional
// individual reference digit (IRN) as an 11th digit.
const MEDICARE = /\b[2-6]\d{3}[ ]?\d{5}[ ]?\d(?:[ ]?\d)?\b/g;

// Australian mobile phone: +61 4XX or 04XX prefix. Match across optional
// spaces, dashes, parentheses. Apply AFTER medicare to avoid mis-redacting
// 10-digit medicare numbers as phones.
const AU_MOBILE = /(?:\+?61[ \-]?|0)4(?:[ \-]?\d){8}\b/g;

// International phone (E.164-ish): +CC XX XXX XXXX with optional separators.
// Excludes the AU pattern via lookahead; minimum 8 digits after country code.
const INTL_PHONE = /\+\d{1,3}(?:[ \-]?\d){8,14}\b/g;

function luhnValid(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function redactPII(input) {
  if (typeof input !== 'string' || !input) return { text: input || '', counts: {} };
  const counts = {};
  const inc = (key) => { counts[key] = (counts[key] || 0) + 1; };

  // Order matters: most specific patterns FIRST so generic shapes don't
  // mis-classify a Medicare or IHI as a phone. Email + private-key + JWT
  // can run anywhere; we keep them up top by tradition.
  let text = input
    .replace(PRIVATE_KEY_BLOCK, () => { inc('private_key'); return '<<REDACTED:PRIVATE_KEY>>'; })
    .replace(JWT, () => { inc('jwt'); return '<<REDACTED:JWT>>'; })
    .replace(GOOGLE_API_KEY, () => { inc('google_api_key'); return '<<REDACTED:GOOGLE_API_KEY>>'; })
    .replace(AWS_KEY, () => { inc('aws_key'); return '<<REDACTED:AWS_KEY>>'; })
    // Credentials before EMAIL: a URI's user:pass@host would otherwise be
    // partly eaten by the email pattern, leaving the password visible.
    .replace(URI_CREDENTIALS, (_m, scheme) => { inc('uri_credentials'); return `${scheme}<<REDACTED:CREDENTIALS>>@`; })
    .replace(GITHUB_PAT, () => { inc('credential'); return '<<REDACTED:CREDENTIAL>>'; })
    .replace(GITHUB_TOKEN, () => { inc('credential'); return '<<REDACTED:CREDENTIAL>>'; })
    .replace(SLACK_TOKEN, () => { inc('credential'); return '<<REDACTED:CREDENTIAL>>'; })
    .replace(STRIPE_KEY, () => { inc('credential'); return '<<REDACTED:CREDENTIAL>>'; })
    .replace(OPENAI_KEY, () => { inc('credential'); return '<<REDACTED:CREDENTIAL>>'; })
    .replace(EMAIL, () => { inc('email'); return '<<REDACTED:EMAIL>>'; })
    .replace(IBAN, () => { inc('iban'); return '<<REDACTED:IBAN>>'; })
    .replace(IHI, () => { inc('ihi'); return '<<REDACTED:IHI>>'; })
    // AU_MOBILE before MEDICARE: phones starting with 04 are unambiguously
    // mobile (Medicare numbers can't start with 0 per the regex tightening
    // above, but matching mobiles first keeps labels accurate).
    .replace(AU_MOBILE, () => { inc('phone'); return '<<REDACTED:PHONE>>'; })
    .replace(INTL_PHONE, () => { inc('phone'); return '<<REDACTED:PHONE>>'; })
    .replace(MEDICARE, () => { inc('medicare'); return '<<REDACTED:MEDICARE>>'; })
    .replace(SSN, () => { inc('ssn'); return '<<REDACTED:SSN>>'; })
    .replace(CARD_CANDIDATE, (match) => {
      const digits = match.replace(/[^0-9]/g, '');
      if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
        inc('card');
        return '<<REDACTED:CARD>>';
      }
      return match;
    });

  return { text, counts };
}

function redactTranscriptLines(lines) {
  if (!Array.isArray(lines)) return { lines: [], counts: {} };
  const totalCounts = {};
  const out = lines.map((line) => {
    if (!line || typeof line.text !== 'string') return line;
    const { text, counts } = redactPII(line.text);
    for (const [k, v] of Object.entries(counts)) totalCounts[k] = (totalCounts[k] || 0) + v;
    return { ...line, text };
  });
  return { lines: out, counts: totalCounts };
}

// Redact an array of short strings (action items, key decisions, topics),
// folding the per-string counts into `acc`.
function redactStringList(items, acc) {
  if (!Array.isArray(items)) return [];
  return items.map((s) => {
    if (typeof s !== 'string') return s;
    const { text, counts } = redactPII(s);
    if (acc) for (const [k, v] of Object.entries(counts)) acc[k] = (acc[k] || 0) + v;
    return text;
  });
}

/**
 * Redact the LLM's structured summary OUTPUT before it is persisted or
 * mirrored to Firestore. The audio itself is never redacted (documented in the
 * consent UI), so spoken PII can surface in the gist / action items / key
 * decisions the model produces — the transcript-only scrub is not enough.
 * Only fields that are present are touched; shape is otherwise preserved.
 */
function redactSummaryOutput(summary) {
  const counts = {};
  const inc = (partCounts) => {
    for (const [k, v] of Object.entries(partCounts)) counts[k] = (counts[k] || 0) + v;
  };
  const out = { ...(summary || {}) };
  if (typeof out.gist === 'string') { const r = redactPII(out.gist); out.gist = r.text; inc(r.counts); }
  if (typeof out.longSummary === 'string') { const r = redactPII(out.longSummary); out.longSummary = r.text; inc(r.counts); }
  if (Array.isArray(out.actionItems)) out.actionItems = redactStringList(out.actionItems, counts);
  if (Array.isArray(out.keyDecisions)) out.keyDecisions = redactStringList(out.keyDecisions, counts);
  if (Array.isArray(out.keyPoints)) out.keyPoints = redactStringList(out.keyPoints, counts);
  if (Array.isArray(out.topics)) out.topics = redactStringList(out.topics, counts);
  return { summary: out, counts };
}

module.exports = {
  redactPII,
  redactTranscriptLines,
  redactStringList,
  redactSummaryOutput,
  luhnValid,
};
