// What a saved Terraform plan would remove that a forgotten TF_VAR would (docs/runbooks/production-incident.md §6).
// A saved plan fixes its variables, so one made without TF_VAR_alert_emails deletes the alert e-mail channels
// (alerts then e-mail nobody), and one without TF_VAR_admin_uids (or a switch's TF_VAR) drops that env var from
// the api, and nothing says so. check-tfplan-env.mjs calls this; a removal that is meant passes with
// --allow-removals, but never a plan that leaves no alert channel at all.

const CHANNEL = 'google_monitoring_notification_channel';
const RUN_TYPES = new Set(['google_cloud_run_v2_service', 'google_cloud_run_v2_job']);

/** Every resource in the planned state, through child modules. */
function plannedResources(mod) {
  if (!mod) return [];
  return [...(mod.resources || []), ...(mod.child_modules || []).flatMap(plannedResources)];
}

/** A Cloud Run service's or job's env names, from a plan's before or after. */
function envNames(type, state) {
  if (!state) return new Set();
  const tmpl = type.endsWith('_job') ? state.template?.[0]?.template?.[0] : state.template?.[0];
  return new Set((tmpl?.containers?.[0]?.env || []).map((e) => e.name));
}

export function removalProblems(plan, { allowRemovals = false } = {}) {
  const problems = [];
  const changes = plan.resource_changes || [];

  // A channel deleted and not recreated (a replace is ['delete', 'create']). The address holds the e-mail, so
  // only the count is reported.
  const deletedChannels = changes.filter(
    (rc) => rc.type === CHANNEL && rc.change?.actions?.includes('delete') && !rc.change.actions.includes('create'),
  );
  if (deletedChannels.length && !allowRemovals) {
    problems.push(`deletes ${deletedChannels.length} alert e-mail channel(s): was TF_VAR_alert_emails exported? (--allow-removals if meant)`);
  }
  if (!plannedResources(plan.planned_values?.root_module).some((r) => r.type === CHANNEL)) {
    problems.push('no alert e-mail channel after this plan: alerts would e-mail nobody (set TF_VAR_alert_emails)');
  }

  if (!allowRemovals) {
    for (const rc of changes) {
      if (!RUN_TYPES.has(rc.type) || !rc.change?.before || !rc.change?.after) continue;
      const after = envNames(rc.type, rc.change.after);
      const dropped = [...envNames(rc.type, rc.change.before)].filter((n) => !after.has(n)).sort();
      if (dropped.length) {
        const kind = rc.type.endsWith('_job') ? 'job' : 'service';
        problems.push(`${kind} ${rc.change.after.name}: drops env ${dropped.join(', ')} (a TF_VAR not exported? --allow-removals if meant)`);
      }
    }
  }
  return problems;
}
