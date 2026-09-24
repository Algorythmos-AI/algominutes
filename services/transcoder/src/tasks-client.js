'use strict';

// Encapsulates the env-bound Cloud Tasks calls used by the transcoder
// service. The actual enqueue lives in shared/cloud-tasks.cjs so
// other services can reuse the same primitive.

function loadShared(name) {
  try { return require(`@algominutes/ai/${name}`); }
  catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return require(`@algominutes/db/${name}`);
    throw err;
  }
}

const sharedTasks = loadShared('cloud-tasks.cjs');

function makeClient({ env, log, traceId, uid }) {
  // Each stage enqueues to its OWN queue (the names Terraform creates). The
  // transcoder re-enqueues its own stt-poll work to the transcode queue, and
  // hands off to the summarize / embed queues. Every task carries this
  // request's traceId, so the whole recording logs under one id.
  const cfg = {
    projectId: env.TASKS_PROJECT,
    location: env.TASKS_LOCATION || 'us-central1',
    transcodeQueue: env.TRANSCODE_QUEUE || 'transcode',
    summarizeQueue: env.SUMMARIZE_QUEUE || 'summarize',
    embedQueue: env.EMBED_QUEUE || 'embed',
    oidcServiceAccount: env.JOBS_SA_EMAIL,
    transcoderUrl: env.TRANSCODER_URL,
    summarizerUrl: env.SUMMARIZER_URL,
    embedderUrl: env.EMBEDDER_URL,
  };

  // The kickoff's uid rides along on every hop (self, summarize, embed), like
  // the traceId, so every worker's logs can name the user.
  const withUid = (payload) => (uid ? { ...(payload || {}), uid } : payload);

  function enqueue(payload, scheduleSeconds) {
    return sharedTasks.enqueueTask({
      projectId: cfg.projectId,
      location: cfg.location,
      queue: cfg.transcodeQueue,
      targetUrl: cfg.transcoderUrl,
      oidcServiceAccount: cfg.oidcServiceAccount,
      payload: withUid(payload),
      scheduleSeconds,
      traceId,
      log,
    });
  }

  function enqueueSummarizer(payload) {
    return sharedTasks.enqueueTask({
      projectId: cfg.projectId,
      location: cfg.location,
      queue: cfg.summarizeQueue,
      targetUrl: cfg.summarizerUrl,
      oidcServiceAccount: cfg.oidcServiceAccount,
      payload: withUid(payload),
      traceId,
      log,
    });
  }

  function enqueueEmbedder(payload) {
    return sharedTasks.enqueueTask({
      projectId: cfg.projectId,
      location: cfg.location,
      queue: cfg.embedQueue,
      targetUrl: cfg.embedderUrl,
      oidcServiceAccount: cfg.oidcServiceAccount,
      payload: withUid(payload),
      traceId,
      log,
    });
  }

  return { enqueue, enqueueSummarizer, enqueueEmbedder, cfg };
}

module.exports = { makeClient };
