// What the meeting is told (docs/CONSENT.md §2.4). The notice is versioned: the
// version is recorded on each bot (meeting_consents.notice_version), so we can
// always say what a meeting saw. It says what's happening and for whom, and
// links to the page that explains it. It must never claim that recording is
// lawful or compliant anywhere (CONSENT §3).
export const NOTICE_VERSION = 'notice-v1';
export const NOTETAKER_PAGE = 'https://algominutes.algorythmos.com/notetaker';

/** "{First name}'s notetaker (AlgoMinutes)", within Recall's 100 characters; the suffix is fixed. */
export function botNameFor(displayName) {
  const suffix = ' (AlgoMinutes)';
  const first = String(displayName || '').trim().split(/\s+/)[0] || '';
  const owner = first ? `${first}'s notetaker` : 'Notetaker';
  return `${owner.slice(0, 100 - suffix.length)}${suffix}`;
}

export function noticeFor(displayName) {
  const first = String(displayName || '').trim().split(/\s+/)[0] || 'a participant';
  return `Hi, I'm ${first}'s notetaker from AlgoMinutes. I'm recording and transcribing this meeting for ${first}. ` +
    `The host can remove me at any time. More about the notetaker: ${NOTETAKER_PAGE}`;
}
