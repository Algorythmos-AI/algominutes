'use strict';

// Cloud Tasks enqueue helper. Each async stage has its OWN queue
// (transcode / summarize / embed / extract / notify — the names Terraform
// creates in infra/terraform/modules/environment/main.tf); the caller passes
// the stage queue and target URL. Tasks reach Cloud Run via OIDC tokens issued
// for the jobs service account; the receiving service must verify the OIDC
// audience matches its own URL.
//
// dispatchDeadline caps how long a single HTTP dispatch may run before Cloud
// Tasks considers it failed and retries. Cloud Run's own request timeout is set
// separately (Terraform, per service). Cloud Tasks allows 15s–1800s; we default
// to the 1800s max so a long-audio handler is never cut off by the queue.

let _client = null;
function getClient() {
  if (_client) return _client;
  const { CloudTasksClient } = require('@google-cloud/tasks');
  _client = new CloudTasksClient();
  return _client;
}

// Cloud Tasks HTTP dispatch-deadline bounds (seconds).
const MIN_DISPATCH_DEADLINE = 15;
const MAX_DISPATCH_DEADLINE = 1800;

function resolveDispatchDeadline(explicit) {
  const raw = explicit ?? (Number(process.env.TASK_DISPATCH_DEADLINE_SECONDS) || MAX_DISPATCH_DEADLINE);
  return Math.min(MAX_DISPATCH_DEADLINE, Math.max(MIN_DISPATCH_DEADLINE, Math.floor(raw)));
}

async function enqueueTask({
  projectId,
  location,
  queue,
  targetUrl,
  payload,
  scheduleSeconds,
  dispatchDeadlineSeconds,
  oidcServiceAccount,
  log,
}) {
  if (!projectId || !location || !queue || !targetUrl || !oidcServiceAccount) {
    throw new Error('enqueueTask: missing required arg');
  }
  const client = getClient();
  const parent = client.queuePath(projectId, location, queue);

  const task = {
    dispatchDeadline: { seconds: resolveDispatchDeadline(dispatchDeadlineSeconds) },
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

module.exports = { enqueueTask, resolveDispatchDeadline };
