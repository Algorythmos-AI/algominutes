import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { MODULE, read, stripComments, mapBody, entries, balanced, srcText } from './helpers/terraform';

// What each service's code calls must match what its runtime identity may do.
// The api calls Vertex for /v1/search and /v1/chat, but run-api was never
// granted roles/aiplatform.user, so both would have answered 403 on the first
// deploy; vertex-smoke runs as run-db-job, so it couldn't notice. This test
// reads what each service's source uses and the roles Terraform grants.
const cloudRun = stripComments(read(`${MODULE}/cloud-run.tf`));
const main = stripComments(read(`${MODULE}/main.tf`));

/** service → runtime service account, from service_config. */
const saOf: Record<string, string> = Object.fromEntries(
  Object.entries(entries(mapBody(cloudRun, 'service_config'))).map(([svc, cfg]) => [svc, /sa\s*=\s*"([\w-]+)"/.exec(cfg)![1]]),
);
saOf['db-job'] = /resource "google_cloud_run_v2_job" "db_job"[\s\S]*?service_account\s*=\s*google_service_account\.runtime\["([\w-]+)"\]/.exec(cloudRun)![1];

/** runtime service account → project roles, from sa_project_roles. */
const rolesOf: Record<string, string[]> = Object.fromEntries(
  Object.entries(entries(mapBody(main, 'sa_project_roles'))).map(([sa, expr]) => {
    const list = balanced(expr, expr.indexOf('['));
    return [sa, [...list.matchAll(/"(roles\/[\w.]+)"/g)].map((m) => m[1])];
  }),
);

/** Service accounts that may mint a token as run-jobs (to enqueue Cloud Tasks). */
const actAsJobs = JSON.parse(
  /resource "google_service_account_iam_member" "act_as_jobs"\s*\{\s*for_each\s*=\s*toset\((\[[^\]]*\])\)/.exec(cloudRun)![1],
) as string[];

const uses = {
  vertex: /aiplatform\.googleapis\.com|gemini-call|embeddings-repo|ai\/embeddings|@google-cloud\/vertexai|@google-cloud\/aiplatform/,
  speech: /speech\.googleapis\.com|@google-cloud\/speech/,
  tasks: /cloud-tasks\.cjs|@google-cloud\/tasks/,
  signing: /getSignedUrl\(/,
};

const services = Object.keys(saOf);
const code = Object.fromEntries(services.map((s) => [s, srcText(`services/${s}/src`)]));

describe('every service can do what its code does', () => {
  it('reads a runtime account and its roles for every service', () => {
    expect(services.sort()).toEqual(['api', 'billing', 'db-job', 'embedder', 'extractor', 'notifier', 'summarizer', 'transcoder']);
    for (const s of services) expect(rolesOf[saOf[s]], `${s} (${saOf[s]}) has no sa_project_roles entry`).toBeDefined();
  });

  it.each(services)('%s', (svc) => {
    const sa = saOf[svc];
    const roles = rolesOf[sa];
    const missing: string[] = [];
    if (uses.vertex.test(code[svc]) && !roles.includes('roles/aiplatform.user')) missing.push('roles/aiplatform.user (calls Vertex)');
    if (uses.speech.test(code[svc]) && !roles.includes('roles/speech.client')) missing.push('roles/speech.client (calls Speech-to-Text)');
    if (uses.tasks.test(code[svc])) {
      if (!roles.includes('roles/cloudtasks.enqueuer')) missing.push('roles/cloudtasks.enqueuer (enqueues Cloud Tasks)');
      if (!actAsJobs.includes(sa)) missing.push('act_as_jobs (tasks carry run-jobs as their OIDC identity)');
    }
    if (uses.signing.test(code[svc])) {
      const self = new RegExp(
        `google_service_account_iam_member"\\s*"\\w+"\\s*\\{[^}]*runtime\\["${sa}"\\]\\.name[^}]*serviceAccountTokenCreator[^}]*runtime\\["${sa}"\\]\\.email`,
      );
      if (!self.test(cloudRun.replace(/resource /g, ''))) missing.push('Token Creator on itself (signs URLs)');
    }
    expect(missing).toEqual([]);
  });

  it('the api is among the Vertex callers (search and chat)', () => {
    expect(uses.vertex.test(code.api)).toBe(true);
  });
});

// The organization's iam.allowedPolicyMemberDomains policy refuses any allUsers
// (or allAuthenticatedUsers) binding, so an apply that adds one fails. Public
// services skip the invoker check instead (invoker_iam_disabled), and only them.
describe('public access', () => {
  const tf = [MODULE, 'infra/terraform/envs/staging', 'infra/terraform/envs/prod']
    .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.tf')).map((f) => stripComments(read(`${d}/${f}`))))
    .join('\n');

  it('binds no role to allUsers or allAuthenticatedUsers', () => {
    expect(tf).not.toMatch(/"allUsers"|"allAuthenticatedUsers"/);
  });

  it('turns the invoker check off for exactly the public services', () => {
    expect(cloudRun).toMatch(/invoker_iam_disabled\s*=\s*contains\(local\.public_services,\s*each\.key\)/);
    expect(JSON.parse(/public_services\s*=\s*(\[[^\]]*\])/.exec(cloudRun)![1])).toEqual(['api', 'billing']);
  });
});
