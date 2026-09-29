#!/usr/bin/env node
// Load on staging (RELEASE.md PR 31): many real recordings at once, each the pipeline e2e's journey
// (scripts/e2e-pipeline.mjs: an anonymous user, the invite code, the upload, the kickoff, ready in both
// stores, the account deleted). It reports how many finished, time to summary at p50 and p95, and, with
// the project's monitoring readable, the peak Cloud SQL CPU and the peak transcoder instances during the
// run. The bar (RELEASE.md): every recording ready, and Cloud SQL CPU under 70%.
//
// It costs real minutes (USERS × MINUTES of speech-to-text and Gemini), so it only plans and prints the
// cost until LOAD_CONFIRM=run. The notetaker's 10 bots aren't here: they need real meetings and Recall
// (the Wave 2 spike).
//
// Env: everything scripts/e2e-pipeline.mjs reads (API_URL, FIREBASE_API_KEY, FIREBASE_PROJECT_ID,
//   E2E_INVITE_CODE: a code with at least USERS redemptions of MINUTES each), plus
//   USERS (default 50), MINUTES (default 15), PARALLEL (default USERS: how many at once),
//   MONITOR_PROJECT (optional: the GCP project whose metrics to read; needs gcloud),
//   COGS_AUD_PER_MINUTE (default 0.03, for the estimate), LOAD_CONFIRM=run to run.
// Exit 1 when a recording failed or Cloud SQL went over 70%.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { e2eConfig, makeRecording, runPipelineE2E } from './e2e-pipeline.mjs';

export const CPU_LIMIT = 0.7;

export function loadConfig(env = process.env) {
  const int = (k, fallback, max) => {
    const v = Number(env[k]);
    if (!env[k]) return fallback;
    if (!Number.isInteger(v) || v < 1 || v > max) throw new Error(`load-staging: ${k} must be a whole number from 1 to ${max}`);
    return v;
  };
  const users = int('USERS', 50, 200);
  const minutes = int('MINUTES', 15, 240);
  const parallel = Math.min(int('PARALLEL', users, 200), users);
  const cogs = Number(env.COGS_AUD_PER_MINUTE ?? 0.03);
  return {
    users,
    minutes,
    parallel,
    monitorProject: (env.MONITOR_PROJECT || '').trim(),
    confirmed: env.LOAD_CONFIRM === 'run',
    estimate: { minutes: users * minutes, aud: Math.round(users * minutes * (Number.isFinite(cogs) && cogs > 0 ? cogs : 0.03) * 100) / 100 },
  };
}

/** Runs `tasks` (functions returning promises), at most `limit` at once, and returns their results in order. */
export async function runLimited(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** The p-th percentile (0-100) of `values`, nearest-rank; null for none. */
export function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** The run's report, from each user's { ok, tookSec }. */
export function summarise(runs, peaks = {}) {
  const ready = runs.filter((r) => r.ok).length;
  const took = runs.map((r) => r.tookSec).filter((t) => t != null);
  const cpuOk = peaks.cloudSqlCpu == null || peaks.cloudSqlCpu < CPU_LIMIT;
  return {
    users: runs.length,
    ready,
    failed: runs.length - ready,
    timeToSummarySec: { p50: percentile(took, 50), p95: percentile(took, 95), max: took.length ? Math.max(...took) : null },
    peaks,
    ok: ready === runs.length && cpuOk,
  };
}

/** The peak of a Cloud Monitoring metric over [startMs, endMs] (gcloud's token; null if unreadable). */
export async function peakMetric({ project, filter, startMs, endMs, token, fetch = globalThis.fetch }) {
  const params = new URLSearchParams({
    filter,
    'interval.startTime': new Date(startMs).toISOString(),
    'interval.endTime': new Date(endMs).toISOString(),
    'aggregation.alignmentPeriod': '60s',
    'aggregation.perSeriesAligner': 'ALIGN_MAX',
  });
  const res = await fetch(`https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(project)}/timeSeries?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const body = await res.json();
  const points = (body.timeSeries || []).flatMap((s) => s.points || []);
  const values = points.map((p) => Number(p.value?.doubleValue ?? p.value?.int64Value)).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

export const METRICS = {
  cloudSqlCpu: 'metric.type="cloudsql.googleapis.com/database/cpu/utilization"',
  transcoderInstances: 'metric.type="run.googleapis.com/container/instance_count" AND resource.labels.service_name="transcoder"',
};

export async function runLoad({ config, e2e, recording, run = runPipelineE2E, token = null, fetch = globalThis.fetch, now = () => Date.now(), write = (s) => process.stdout.write(s) }) {
  write(`load: ${config.users} users × ${config.minutes} min, ${config.parallel} at once: about ${config.estimate.minutes} min, A$${config.estimate.aud}\n`);
  if (!config.confirmed) {
    write('plan only: set LOAD_CONFIRM=run to run it\n');
    return { ran: false };
  }
  const started = now();
  const runs = await runLimited(
    Array.from({ length: config.users }, (_, i) => async () => {
      const prefix = `[${String(i + 1).padStart(3, '0')}] `;
      const r = await run({ ...e2e, minutes: config.minutes, recording, write: (s) => write(prefix + s) }).catch((err) => {
        write(`${prefix}FAIL the run threw (${String(err?.message ?? err).slice(0, 200)})\n`);
        return { ok: false, tookSec: null };
      });
      return { ok: Boolean(r?.ok), tookSec: r?.tookSec ?? null };
    }),
    config.parallel,
  );
  const ended = now();
  const peaks = {};
  if (config.monitorProject && token) {
    for (const [name, filter] of Object.entries(METRICS)) {
      peaks[name] = await peakMetric({ project: config.monitorProject, filter, startMs: started, endMs: ended, token, fetch });
    }
  }
  const report = summarise(runs, peaks);
  write(`${JSON.stringify(report, null, 2)}\n`);
  if (config.monitorProject && peaks.cloudSqlCpu == null) write('note: Cloud SQL CPU could not be read\n');
  return { ran: true, report };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadConfig();
  const e2e = config.confirmed ? e2eConfig() : {};
  const recording = config.confirmed ? makeRecording(config.minutes) : null;
  const token = config.confirmed && config.monitorProject ? execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim() : null;
  const out = await runLoad({ config, e2e, recording, token });
  process.exit(!out.ran || out.report.ok ? 0 : 1);
}
