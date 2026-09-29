// The meetings queue's dead letters (RELEASE.md PR 21; CLAUDE.md §2 "dead-letter queue on every queue"): a task
// out of attempts is written to Postgres with its ids and its error, so the admin view lists it
// (GET /v1/admin/dead-letters) and `dead_letter_recorded` alerts. The payload holds ids only, never a meeting
// link or anything said.
export async function recordMeetingsDeadLetter({ repo, kind, bot = null, payload = {}, err, attempts, traceId, log }) {
  try {
    const r = await repo.recordDeadLetter({
      queue: 'meetings',
      noteId: bot?.noteId ?? null,
      workspaceId: bot?.workspaceId ?? null,
      payload: { kind, ...(bot ? { meetingBotId: bot.id } : {}), ...payload },
      error: String(err?.message ?? err).slice(0, 1000),
      attempts,
      traceId: traceId ?? bot?.traceId ?? null,
    });
    log.info({ deadLetterId: r?.id ?? null, queue: 'meetings', kind }, 'dead_letter_recorded');
  } catch (dlErr) {
    // The failure is then only in this line: dead_letter_record_failed alerts (RELEASE.md PR 15b's alert,
    // shared with the workers' dead letters).
    log.error({ err: dlErr, queue: 'meetings', kind }, 'dead_letter_record_failed');
  }
}
