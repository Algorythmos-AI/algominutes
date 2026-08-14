'use strict';

// Cloud Tasks enqueue helper. One queue (audio-jobs) carries all four
// task kinds (kickoff, stt-poll, summarize, embed) discriminated by
// `payload.kind`. Tasks reach Cloud Run via OIDC tokens issued for the
// jobs service account; the receiving service must verify the OIDC
// audience matches its own URL.

let _client = null;
function getClient() {
  if (_client) return _client;
  const { CloudTasksClient } = require('@google-cloud/tasks');
  _client = new CloudTasksClient();
  return _client;
}

async function enqueueTask({
  projectId,
  location,
  queue,
  targetUrl,
  payload,
  scheduleSeconds,
  oidcServiceAccount,
  log,
}) {
  if (!projectId || !location || !queue || !targetUrl || !oidcServiceAccount) {
    throw new Error('enqueueTask: missing required arg');
  }
  const client = getClient();
  const parent = client.queuePath(projectId, location, queue);

  const task = {
    httpRequest: {
      httpMethod: 'POST',
      url: targetUrl,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(payload || {})).toString('base64'),
      oidcToken: {
        serviceAccountEmail: oidcServiceAccount,
        audience: targetUrl,
      },
    },
  };

  if (scheduleSeconds && scheduleSeconds > 0) {
    task.scheduleTime = { seconds: Math.floor(Date.now() / 1000) + Math.floor(scheduleSeconds) };
  }

  const [response] = await client.createTask({ parent, task });
  if (log) log.info({ kind: payload && payload.kind, name: response.name }, 'task_enqueued');
  return response.name;
}

module.exports = { enqueueTask };
