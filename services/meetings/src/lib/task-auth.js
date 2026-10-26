// /tasks/* is called only by Cloud Tasks, as run-jobs, with an OIDC token: the check is shared with billing
// (@algominutes/ai/task-auth.cjs), so both public services verify task tokens the same way.
import taskAuthModule from '@algominutes/ai/task-auth.cjs';

export const { createTaskAuth } = taskAuthModule;
