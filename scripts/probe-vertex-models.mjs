#!/usr/bin/env node
// Which Gemini models Vertex AI actually serves in our region (read-only, free).
//
// Google's region tables change, and a model that isn't served in
// australia-southeast1 must not enter the ladder (models.cjs, data residency).
// This asks the regional endpoint directly with countTokens, which costs nothing
// and writes nothing: 200 means served here, 404 means not.
//
//   node scripts/probe-vertex-models.mjs [--project P] [--account A] [candidate ...]
//
// With no candidates it probes every generative model in the registry. Run it
// when the model tripwire fires, before adding a rung.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MODELS, REGION } = require('../packages/ai/src/models.cjs');

export function parseArgs(argv) {
  const out = { project: process.env.GCP_PROJECT_ID || 'algominutes-staging', account: '', candidates: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') out.project = argv[++i];
    else if (argv[i] === '--account') out.account = argv[++i];
    else out.candidates.push(argv[i]);
  }
  if (!out.candidates.length) out.candidates = Object.keys(MODELS).filter((id) => MODELS[id].kind === 'generative');
  return out;
}

export async function probe({ project, region = REGION, token, candidates, doFetch = fetch }) {
  const results = [];
  for (const model of candidates) {
    const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:countTokens`;
    const res = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }),
    });
    results.push({ model, served: res.status === 200, status: res.status });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const token = execFileSync('gcloud', ['auth', 'print-access-token', ...(args.account ? [`--account=${args.account}`] : [])], { encoding: 'utf8' }).trim();
  const results = await probe({ project: args.project, token, candidates: args.candidates });
  for (const r of results) process.stdout.write(`${r.model.padEnd(28)} ${r.served ? `served in ${REGION}` : `not served (${r.status})`}\n`);
}
