import { describe, it, expect } from 'vitest';
import { MODULE, read, stripComments } from './helpers/terraform';

// RELEASE.md rev 11, H7: the pipeline never drops work, and its quiet failures alert.
const main = stripComments(read(`${MODULE}/main.tf`));
const cloudRun = stripComments(read(`${MODULE}/cloud-run.tf`));
const variables = stripComments(read(`${MODULE}/variables.tf`));
const alerting = stripComments(read(`${MODULE}/alerting.tf`));
const pipeline = stripComments(read(`${MODULE}/alerting-pipeline.tf`));

describe('the pipeline never drops work', () => {
  it("the transcoder's request timeout fits inside a task's dispatch deadline", () => {
    // A request that outlives the deadline is delivered again while it still runs (rev 11, L6).
    const timeout = Number(/transcoder\s*=\s*\{[^}]*timeout\s*=\s*(\d+)/.exec(cloudRun)![1]);
    const deadline = Number(/TASK_DISPATCH_DEADLINE_SECONDS\s*=\s*"(\d+)"/.exec(cloudRun)![1]);
    expect(timeout).toBeLessThanOrEqual(deadline);
  });

  it('every queue backs off up to 600 s, and the shared budget is 10 attempts', () => {
    expect(main).toMatch(/max_backoff\s*=\s*"600s"/);
    expect(main).not.toMatch(/"300s"/);
    expect(/variable "task_max_attempts" \{[^}]*default\s*=\s*(\d+)/.exec(variables)![1]).toBe('10');
  });

  it('Cloud SQL updates in a set quiet hour', () => {
    expect(main).toMatch(/maintenance_window\s*\{\s*day\s*=\s*7\s*hour\s*=\s*16\s*update_track\s*=\s*"stable"\s*\}/);
  });
});

describe('the quiet failures alert', () => {
  it('a truncated Gemini answer', () => {
    expect(alerting).toMatch(/gemini_output_truncated\s*=\s*\{/);
  });

  it("the sweep's absence, a failed Scheduler job, a queue backing up, and Cloud SQL near its limits", () => {
    expect(pipeline).toMatch(/condition_absent\s*\{[\s\S]*?sweep_done/);
    expect(pipeline).toMatch(/resource\.type=\\"cloud_scheduler_job\\" AND severity>=ERROR/);
    expect(pipeline).toContain('cloudtasks.googleapis.com/queue/depth');
    expect(pipeline).toContain('cloudsql.googleapis.com/database/cpu/utilization');
    expect(pipeline).toContain('cloudsql.googleapis.com/database/postgresql/num_backends');
    // Each one emails the same people as every other alert.
    expect(pipeline.match(/notification_channels\s*=\s*local\.alert_channels/g)).toHaveLength(4);
  });
});
