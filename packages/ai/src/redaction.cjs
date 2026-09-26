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
// Private keys are found by a linear scan (redactPrivateKeys below), not one
// regex. The old /-----BEGIN …PRIVATE KEY-----[\s\S]+?-----END [^-]+PRIVATE KEY-----/
// missed the most common format entirely: PKCS#8 (`BEGIN PRIVATE KEY`, how GCP
// service-account keys look), because `[^-]+` needs a type word before
// PRIVATE. Encrypted PKCS#8 and PGP blocks were missed too. It was also
// quadratic: each BEGIN scanned to the end of the text for an END (CodeQL
// js/polynomial-redos; 216 KB took 0.7 s).
const PK_BEGIN = /-----BEGIN ((?:[A-Z0-9]{1,16} ){0,3})PRIVATE KEY( BLOCK)?-----/g;
const PK_END = /-----END ((?:[A-Z0-9]{1,16} ){0,3})PRIVATE KEY( BLOCK)?-----/g;
const PK_END_AT = /-----END (?:[A-Z0-9]{1,16} ){0,3}PRIVATE KEY(?: BLOCK)?-----/y;
// The body of a key with no END marker (truncated or pasted in part): a run of
// line breaks, spaces, base64 of 16+ characters (or a shorter final line ending
// in = padding, or a PGP checksum), and PEM/PGP header lines. Prose stops it:
// ordinary words are shorter than 16 characters. Each token is non-empty, the
// count is bounded, and nothing follows the group, so the engine never
// backtracks into it (keep it that way): linear time.
const PK_BODY = /(?:\r?\n|\r|[ \t]+|[A-Za-z0-9+/=]{16,}|[A-Za-z0-9+/]{2,15}={1,2}|=[A-Za-z0-9+/]{4}|(?:Proc-Type|DEK-Info|Comment|Version|Charset|Hash|MessageID):[^\n]{0,200}){0,4096}/y;
const PK_TAG = '<<REDACTED:PRIVATE_KEY>>';
const PK_MAX_BODY = 32 * 1024; // the largest real PEM key is well under this
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

/**
 * Replace every PEM/PGP private key block with the tag, in one linear pass.
 * A BEGIN with its matching END (same type, within PK_MAX_BODY) redacts through
 * the END. A BEGIN without one redacts the marker and the base64 body that
 * follows, so a truncated key still doesn't leak. Returns the text, the block
 * count, and `open`: whether the text ENDS inside a key with no END, so a caller
 * scrubbing line by line keeps redacting the next lines (redactLines).
 */
function redactPrivateKeys(text) {
  if (typeof text !== 'string' || text.indexOf('-----BEGIN ') === -1) return { text, n: 0, open: false };
  // Every END position per marker, found in ONE pass. Each BEGIN then advances
  // a per-marker pointer, so the whole scan is O(n) however many key types (or
  // made-up type words) the text contains.
  const ends = new Map();
  PK_END.lastIndex = 0;
  let e;
  while ((e = PK_END.exec(text)) !== null) {
    const list = ends.get(e[0]);
    if (list) list.push(e.index);
    else ends.set(e[0], [e.index]);
  }
  const cursor = new Map();

  let out = '';
  let last = 0;
  let n = 0;
  let open = false;
  PK_BEGIN.lastIndex = 0;
  let m;
  while ((m = PK_BEGIN.exec(text)) !== null) {
    const bodyStart = PK_BEGIN.lastIndex;
    const endMarker = `-----END ${m[1]}PRIVATE KEY${m[2] || ''}-----`;
    const list = ends.get(endMarker) || [];
    let i = cursor.get(endMarker) || 0;
    while (i < list.length && list[i] < bodyStart) i += 1;
    cursor.set(endMarker, i);
    let stop;
    if (i < list.length && list[i] - bodyStart <= PK_MAX_BODY) {
      stop = list[i] + endMarker.length;
      open = false;
    } else {
      PK_BODY.lastIndex = bodyStart;
      const body = PK_BODY.exec(text);
      stop = bodyStart + (body ? body[0].length : 0);
      open = stop >= text.length;
    }
    out += text.slice(last, m.index) + '<<REDACTED:PRIVATE_KEY>>';
    n += 1;
    last = stop;
    PK_BEGIN.lastIndex = stop;
  }
  return { text: n ? out + text.slice(last) : text, n, open };
}

/**
 * The start of a line that continues a key opened on an earlier line: through
 * its END marker, else through its key body. Returns the redacted line and
 * whether the key is still open after it.
 */
function continueOpenKey(text) {
  const at = text.indexOf('-----END ');
  if (at !== -1) {
    PK_END_AT.lastIndex = at;
    const endM = PK_END_AT.exec(text);
    PK_BODY.lastIndex = 0;
    const lead = PK_BODY.exec(text);
    // Only when everything before the END is key body (no prose in between).
    if (endM && lead && lead[0].length >= at) {
      return { text: '<<REDACTED:PRIVATE_KEY>>' + text.slice(at + endM[0].length), open: false };
    }
  }
  PK_BODY.lastIndex = 0;
  const body = PK_BODY.exec(text);
  const len = body ? body[0].length : 0;
  if (!len) return { text, open: false };
  return { text: '<<REDACTED:PRIVATE_KEY>>' + text.slice(len), open: len >= text.length };
}

function redactPII(input) {
  const { text, counts } = scrub(input, false);
  return { text, counts };
}

/**
 * redactPII, plus whether the text ends inside an unterminated private key.
 * `continuingKey`: the previous line ended inside one, so this line's leading
 * key body is redacted too.
 */
function scrub(input, continuingKey) {
  // A blank line inside a key (PGP and encrypted PEM put one after their
  // headers) keeps it open.
  if (typeof input !== 'string' || !input) return { text: input || '', counts: {}, keyOpen: !!continuingKey && input === '' };
  const counts = {};
  const inc = (key) => { counts[key] = (counts[key] || 0) + 1; };

  let source = input;
  let open = false;
  if (continuingKey) {
    const cont = continueOpenKey(input);
    source = cont.text;
    open = cont.open;
  }
  // Order matters: most specific patterns FIRST so generic shapes don't
  // mis-classify a Medicare or IHI as a phone. Private keys go first of all,
  // so later patterns can't split a key body into pieces.
  const keys = open ? { text: source, n: 0, open: true } : redactPrivateKeys(source);
  if (keys.n) counts.private_key = keys.n;
  let text = keys.text
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

  return { text, counts, keyOpen: keys.open };
}

/**
 * Redact consecutive lines of one text (a transcript, line by line), carrying
 * an unterminated private key from one line into the next. Scrubbing each line
 * alone would redact a key's BEGIN line but let its later base64 lines
 * through. Returns the same number of lines, in order.
 *
 * A line that ALREADY ends in the private-key tag (redacted when it was
 * stored, e.g. a key whose body continued into the next audio chunk's lines)
 * reopens the key for the lines after it. That can over-redact a following
 * line's leading 16+-character word, never under-redact.
 */
function redactLines(texts) {
  if (!Array.isArray(texts)) return { texts: [], counts: {} };
  const totalCounts = {};
  let open = false;
  const out = texts.map((t) => {
    if (typeof t !== 'string') return t;
    const r = scrub(t, open);
    open = r.keyOpen || t.trimEnd().endsWith(PK_TAG);
    for (const [k, v] of Object.entries(r.counts)) totalCounts[k] = (totalCounts[k] || 0) + v;
    return r.text;
  });
  return { texts: out, counts: totalCounts };
}

function redactTranscriptLines(lines) {
  if (!Array.isArray(lines)) return { lines: [], counts: {} };
  const { texts, counts } = redactLines(lines.map((line) => (line && typeof line.text === 'string' ? line.text : null)));
  const out = lines.map((line, i) => {
    let next = line && typeof line.text === 'string' ? { ...line, text: texts[i] } : line;
    // The fast path's speaker labels are the model's, written after hearing raw
    // audio, so one can be what someone said ("this is jane@example.com").
    if (line && typeof line.speaker === 'string') {
      const r = redactPII(line.speaker);
      if (r.text !== line.speaker) {
        next = { ...next, speaker: r.text };
        for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] || 0) + v;
      }
    }
    return next;
  });
  return { lines: out, counts };
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
  if (Array.isArray(out.chapters)) {
    out.chapters = out.chapters.map((c) => {
      if (!c || typeof c !== 'object') return c;
      const next = { ...c };
      if (typeof next.title === 'string') { const r = redactPII(next.title); next.title = r.text; inc(r.counts); }
      if (typeof next.summary === 'string') { const r = redactPII(next.summary); next.summary = r.text; inc(r.counts); }
      return next;
    });
  }
  return { summary: out, counts };
}

module.exports = {
  redactPII,
  redactLines,
  redactPrivateKeys,
  redactTranscriptLines,
  redactStringList,
  redactSummaryOutput,
  luhnValid,
};
