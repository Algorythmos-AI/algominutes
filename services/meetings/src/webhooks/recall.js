// POST /webhooks/recall — every Recall.ai webhook (docs/plans/MEETINGS.md).
//
// Verify, store, answer. The signature is checked over the exact bytes
// received (express.raw). Then the event is stored once by its webhook id and
// answered 2xx straight away; the work it triggers runs from the stored row.
//
// Never a 4xx for a delivery Recall really sent: Svix retries a failure for
// about 28 hours and then DISABLES the endpoint, losing every later event. So
// an event for a bot we don't know is stored and answered 200 (a reconcile
// picks it up), and one for another environment is answered 200 and ignored.
// Only a delivery that fails the signature (not from Recall) gets a 401, and
// each one is logged for the alert.
import { recordRecallEvent } from '@algominutes/db';
import { verifyRecallSignature } from '../lib/recall-signature.js';
import { splitSecrets } from '../lib/secrets.js';

export const WEBHOOK_SECRET_ID = 'recall-webhook-secret';

/** The fields we key on, from either kind of Recall webhook (bot status, or recording/artifact). */
export function eventFields(body) {
  const data = body?.data ?? {};
  const bot = data.bot ?? {};
  const inner = data.data ?? {};
  const metadata = bot.metadata ?? {};
  const at = inner.updated_at ? new Date(inner.updated_at) : null;
  return {
    event: typeof body?.event === 'string' ? body.event : 'unknown',
    recallBotId: typeof bot.id === 'string' ? bot.id : null,
    meetingBotId: typeof metadata.meeting_bot_id === 'string' ? metadata.meeting_bot_id : null,
    env: typeof metadata.env === 'string' ? metadata.env : null,
    subCode: typeof inner.sub_code === 'string' ? inner.sub_code : null,
    occurredAt: at && !Number.isNaN(at.getTime()) ? at : null,
  };
}

export function createRecallWebhookRoute({ readSecret, env = process.env, record = recordRecallEvent, now = Date.now }) {
  return async function recallWebhookRoute(req, res) {
    const log = req.log;
    let secrets;
    try {
      secrets = splitSecrets(await readSecret(WEBHOOK_SECRET_ID, { log }));
    } catch (err) {
      log.error({ err }, 'recall_webhook_secret_unreadable');
      return res.status(503).json({ error: 'Not configured' });
    }
    if (!secrets.length) {
      log.error({}, 'recall_webhook_secret_missing');
      return res.status(503).json({ error: 'Not configured' });
    }
    const verdict = verifyRecallSignature({ rawBody: req.body, headers: req.headers, secrets, now: now() });
    if (!verdict.ok) {
      log.warn({ reason: verdict.reason }, 'recall_webhook_signature_failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let body;
    try {
      body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || ''));
    } catch (err) {
      // Signed but not JSON: nothing to act on, and nothing a retry would change.
      log.error({ err, webhookId: verdict.id }, 'recall_webhook_unparseable');
      return res.status(200).json({ ok: true });
    }
    const f = eventFields(body);
    const fields = { webhookId: verdict.id, event: f.event, recallBotId: f.recallBotId, meetingBotId: f.meetingBotId };
    const ours = String(env.ALGOMINUTES_ENV || '');
    if (f.env && ours && f.env !== ours) {
      log.warn({ ...fields, eventEnv: f.env }, 'recall_webhook_other_env');
      return res.status(200).json({ ok: true });
    }
    const stored = await record({
      webhookId: verdict.id,
      meetingBotId: f.meetingBotId,
      recallBotId: f.recallBotId,
      event: f.event,
      subCode: f.subCode,
      occurredAt: f.occurredAt,
      payload: body,
    });
    log.info({ ...fields, duplicate: !stored.inserted }, 'recall_webhook_received');
    return res.status(200).json({ ok: true });
  };
}
