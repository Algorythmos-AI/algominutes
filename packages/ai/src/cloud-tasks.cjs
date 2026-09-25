'use strict';

// Cloud Tasks enqueue helper. Each async stage has its OWN queue
// (transcode / summarize / embed / extract / notify — the names Terraform
// creates in infra/terraform/modules/environment/main.tf); the caller passes
// the stage queue and target URL. Tasks reach Cloud Run via OIDC tokens issued
// for the jobs service account; the receiving service must verify the OIDC
// audience matches its own URL.
//
// Every task carries the enqueuer's traceId in its body, and each worker logs
// under it (logger.cjs traceIdFromTask), so one recording is followable end to
// end across services (CLAUDE.md §1). enqueueTask refuses to enqueue without
// one.
//
// dispatchDeadline caps how long a single HTTP dispatch may run before Cloud
// Tasks considers it failed and retries. Cloud Run's own request timeout is set
// separately (Terraform, per service). Cloud Tasks allows 15s–1800s; we default
// to the 1800s max so a long-audio handler is never cut off by the queue.

const { isTraceId } = require('./logger.cjs');

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
  traceId,
  log,
  // Optional deterministic task id: a second create with the same id (a replay,
  // or a duplicate chain) is dropped by Cloud Tasks, and treated here as done.
  taskId,
  client = getClient(),
}) {
  if (!projectId || !location || !queue || !targetUrl || !oidcServiceAccount) {
    throw new Error('enqueueTask: missing required arg');
  }
  if (!isTraceId(traceId)) {
    throw new Error('enqueueTask: missing traceId (it must cross every async hop, CLAUDE.md §1)');
  }
  const parent = client.queuePath(projectId, location, queue);

  const task = {
    dispatchDeadline: { seconds: resolveDispatchDeadline(dispatchDeadlineSeconds) },
    httpRequest: {
      httpMethod: 'POST',
      url: targetUrl,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ ...(payload || {}), traceId })).toString('base64'),
      oidcToken: {
        serviceAccountEmail: oidcServiceAccount,
        audience: targetUrl,
      },
    },
  };

  if (scheduleSeconds && scheduleSeconds > 0) {
    task.scheduleTime = { seconds: Math.floor(Date.now() / 1000) + Math.floor(scheduleSeconds) };
  }
  if (taskId !== undefined) {
    // Cloud Tasks' own rule for task ids. Lead with something random (a uuid):
    // sequential prefixes slow the queue down.
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,500}$/.test(taskId)) {
      throw new Error('enqueueTask: taskId must be 1-500 letters, digits, - or _');
    }
    task.name = `${parent}/tasks/${taskId}`;
  }

  let response;
  try {
    [response] = await client.createTask({ parent, task });
  } catch (err) {
    // ALREADY_EXISTS (gRPC 6): the same named task was created, or ran within
    // the last hour or so. It is the same work, so the duplicate is dropped.
    if (task.name && (err?.code === 6 || /ALREADY_EXISTS/.test(String(err?.message)))) {
      if (log) log.info({ kind: payload && payload.kind, name: task.name, queue, traceId }, 'task_already_exists');
      return task.name;
    }
    throw err;
  }
  if (log) log.info({ kind: payload && payload.kind, name: response.name, queue, traceId }, 'task_enqueued');
  return response.name;
}

module.exports = { enqueueTask, resolveDispatchDeadline };
