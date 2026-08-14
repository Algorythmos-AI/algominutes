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

function makeClient({ env, log }) {
  const cfg = {
    projectId: env.TASKS_PROJECT,
    location: env.TASKS_LOCATION || 'us-central1',
    queue: env.TASKS_QUEUE || 'audio-jobs',
    oidcServiceAccount: env.JOBS_SA_EMAIL,
    transcoderUrl: env.TRANSCODER_URL,
    summarizerUrl: env.SUMMARIZER_URL,
    embedderUrl: env.EMBEDDER_URL,
  };

  function enqueue(payload, scheduleSeconds) {
    return sharedTasks.enqueueTask({
      projectId: cfg.projectId,
      location: cfg.location,
      queue: cfg.queue,
      targetUrl: cfg.transcoderUrl,
      oidcServiceAccount: cfg.oidcServiceAccount,
      payload,
      scheduleSeconds,
      log,
    });
  }

  function enqueueSummarizer(payload) {
    return sharedTasks.enqueueTask({
      projectId: cfg.projectId,
      location: cfg.location,
      queue: cfg.queue,
      targetUrl: cfg.summarizerUrl,
      oidcServiceAccount: cfg.oidcServiceAccount,
      payload,
      log,
    });
  }

  function enqueueEmbedder(payload) {
    return sharedTasks.enqueueTask({
      projectId: cfg.projectId,
      location: cfg.location,
      queue: cfg.queue,
      targetUrl: cfg.embedderUrl,
      oidcServiceAccount: cfg.oidcServiceAccount,
      payload,
      log,
    });
  }

  return { enqueue, enqueueSummarizer, enqueueEmbedder, cfg };
}

module.exports = { makeClient };
