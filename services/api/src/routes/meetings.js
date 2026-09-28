// POST /v1/meetings/bots and POST /v1/meetings/bots/:botId/cancel — the
// online-meeting notetaker (docs/plans/MEETINGS.md, M1).
//
// Contract-first stubs: until the notetaker is built and switched on (GET
// /v1/config `notetaker.bot`), both answer 503 feature_disabled, the
// FeatureDisabledError contract. The api never calls Recall inside a request;
// the real handlers write intent rows through the repo and enqueue a task.
const DISABLED = { error: "The notetaker isn't available yet.", code: 'feature_disabled' };

function disabled(req, res, route) {
  req.log.info({ route }, 'notetaker_disabled');
  return res.status(503).json(DISABLED);
}

// Both stay disabled until 'bot' is added to NOTETAKER_BUILT (app-config.js)
// together with the real handler, so the switch alone can never expose them.
export async function createMeetingBotRoute(req, res) {
  return disabled(req, res, 'create_bot');
}

export async function cancelMeetingBotRoute(req, res) {
  return disabled(req, res, 'cancel_bot');
}
