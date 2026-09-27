#!/usr/bin/env node
// Whether web-e2e (.github/workflows/web-e2e.yml) runs now. Staging is two deploys
// of integration's head: the site (Vercel) and the backend (deploy-staging, only
// when backend paths change). The journey is worth running only once both have
// finished, so each finishing deploy asks "is staging coherent now?", and the
// last one to finish starts the run.
//
// Neither event says so by itself:
// - Vercel reports every branch as a "Preview" deployment whose ref is the commit
//   SHA, and PR previews too, so a deployment is integration's only if its commit
//   is integration's head;
// - Vercel usually finishes while deploy-staging is still migrating or rolling out;
// - deploy-staging's own jobs each report a `staging` deployment, the build job's
//   before anything is rolled out (so the workflow listens for its completion).
//
// Env: GITHUB_REPOSITORY, GITHUB_TOKEN (actions: read, deployments: read),
// EVENT (github.event_name), EVENT_SHA (the deployment's commit, for
// deployment_status), HAS_BYPASS ('true' when VERCEL_AUTOMATION_BYPASS_SECRET is
// set), GITHUB_OUTPUT. Writes run=true|false; prints why.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const short = (sha) => (sha ? sha.slice(0, 7) : '(none)');

/**
 * The decision, from what GitHub says now.
 * site: the state of Vercel's newest deployment of head ('success', 'pending', 'failure', ..., or 'none');
 * deploying: a deploy-staging run hasn't finished (queued, waiting its turn, or running); backend: head's newest
 * deploy-staging run, or null when head changed no backend path; lastBackend: then, integration's newest finished
 * one (not cancelled or skipped), which is what staging's backend is running.
 */
export function decide({ event, eventSha, head, site, deploying, backend, lastBackend, hasBypass }) {
  const skip = (why, level = 'notice') => ({ run: false, level, why });
  if (event !== 'schedule' && event !== 'workflow_dispatch') {
    if (event === 'deployment_status' && eventSha !== head) {
      return skip(`Vercel deployed ${short(eventSha)}, not integration's head (${short(head)}): a PR preview, or superseded.`);
    }
    if (site !== 'success') return skip(`The site for ${short(head)} isn't deployed yet (${site}); its deployment will start the run.`);
    if (deploying) return skip('deploy-staging is still running; its completion will start the run.');
    if (backend && backend.conclusion !== 'success') {
      return skip(`deploy-staging for ${short(head)} ended ${backend.conclusion ?? backend.status}: staging isn't coherent, so there's nothing to test.`, 'warning');
    }
    if (!backend && lastBackend && lastBackend.conclusion !== 'success') {
      return skip(`The last deploy-staging (${short(lastBackend.sha)}) ended ${lastBackend.conclusion}: staging's backend isn't a good build, so there's nothing to test.`, 'warning');
    }
  }
  if (!hasBypass) {
    return skip("VERCEL_AUTOMATION_BYPASS_SECRET isn't set, so staging (behind Vercel Authentication) can't be reached. See docs/runbooks/site.md.", 'warning');
  }
  return { run: true, level: 'notice', why: event === 'schedule' || event === 'workflow_dispatch' ? `${event}: runs against staging as it is.` : `Staging is integration's head (${short(head)}), site and backend.` };
}

/** What the decision needs, from GitHub's REST API. */
export async function gather({ repo, token, doFetch = fetch }) {
  const get = async (path) => {
    const res = await doFetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return res.json();
  };
  const head = (await get('commits/integration')).sha;
  const deployments = await get(`deployments?sha=${head}&environment=Preview&per_page=20`);
  const vercel = deployments.find((d) => d.creator?.login === 'vercel[bot]');
  const site = vercel ? ((await get(`deployments/${vercel.id}/statuses?per_page=1`))[0]?.state ?? 'pending') : 'none';
  const runs = (query) => get(`actions/workflows/deploy-staging.yml/runs?${query}`);
  // Every state before "completed": deploy-staging's own concurrency group holds a second deploy as pending.
  const unfinished = ['requested', 'queued', 'pending', 'waiting', 'in_progress'];
  const deploying = (await Promise.all(unfinished.map((s) => runs(`branch=integration&status=${s}&per_page=1`)))).some((r) => r.total_count > 0);
  const latest = (await runs(`head_sha=${head}&per_page=1`)).workflow_runs?.[0];
  const backend = latest ? { status: latest.status, conclusion: latest.conclusion } : null;
  let lastBackend = null;
  if (!backend) {
    const done = (await runs('branch=integration&status=completed&per_page=10')).workflow_runs ?? [];
    const last = done.find((r) => r.conclusion !== 'cancelled' && r.conclusion !== 'skipped');
    if (last) lastBackend = { sha: last.head_sha, conclusion: last.conclusion };
  }
  return { head, site, deploying, backend, lastBackend };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = process.env;
  const event = env.EVENT ?? '';
  const needsState = event !== 'schedule' && event !== 'workflow_dispatch';
  const state = needsState ? await gather({ repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN }) : {};
  const d = decide({ event, eventSha: env.EVENT_SHA ?? '', hasBypass: env.HAS_BYPASS === 'true', ...state });
  if (needsState) process.stdout.write(`head ${short(state.head)}: site ${state.site}, deploy-staging running ${state.deploying}, head's deploy ${state.backend ? `${state.backend.status}/${state.backend.conclusion}` : `none (last: ${state.lastBackend ? `${short(state.lastBackend.sha)} ${state.lastBackend.conclusion}` : 'none'})`}\n`);
  process.stdout.write(`::${d.level}::${d.why}\n`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `run=${d.run}\n`);
}
