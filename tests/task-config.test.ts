import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveDispatchDeadline } = require('@algominutes/ai/cloud-tasks.cjs') as typeof import('../packages/ai/src/cloud-tasks.cjs');
const { isFinalAttempt } = require('@algominutes/ai/note-terminal.cjs') as typeof import('../packages/ai/src/note-terminal.cjs');

const savedDeadline = process.env.TASK_DISPATCH_DEADLINE_SECONDS;
const savedAttempts = process.env.MAX_TASK_ATTEMPTS;
afterEach(() => {
  process.env.TASK_DISPATCH_DEADLINE_SECONDS = savedDeadline;
  process.env.MAX_TASK_ATTEMPTS = savedAttempts;
  if (savedDeadline === undefined) delete process.env.TASK_DISPATCH_DEADLINE_SECONDS;
  if (savedAttempts === undefined) delete process.env.MAX_TASK_ATTEMPTS;
});

describe('resolveDispatchDeadline', () => {
  it('defaults to the 1800s Cloud Tasks maximum', () => {
    delete process.env.TASK_DISPATCH_DEADLINE_SECONDS;
    expect(resolveDispatchDeadline()).toBe(1800);
  });

  it('clamps to the 15s..1800s range', () => {
    expect(resolveDispatchDeadline(5)).toBe(15);
    expect(resolveDispatchDeadline(99999)).toBe(1800);
    expect(resolveDispatchDeadline(600)).toBe(600);
  });

  it('reads TASK_DISPATCH_DEADLINE_SECONDS when no explicit value is passed', () => {
    process.env.TASK_DISPATCH_DEADLINE_SECONDS = '300';
    expect(resolveDispatchDeadline()).toBe(300);
  });
});

describe('isFinalAttempt', () => {
  const headers = (n: number) => ({ 'x-cloudtasks-taskretrycount': String(n) });

  it('fires on the last attempt for the default budget of 5', () => {
    delete process.env.MAX_TASK_ATTEMPTS;
    expect(isFinalAttempt(headers(3))).toBe(false); // 4th attempt
    expect(isFinalAttempt(headers(4))).toBe(true); // 5th (last)
  });

  it('is driven by MAX_TASK_ATTEMPTS so it matches the queue config', () => {
    process.env.MAX_TASK_ATTEMPTS = '10';
    expect(isFinalAttempt(headers(4))).toBe(false); // 5th of 10
    expect(isFinalAttempt(headers(9))).toBe(true); // 10th (last)
  });

  it('an explicit argument still overrides the env', () => {
    process.env.MAX_TASK_ATTEMPTS = '10';
    expect(isFinalAttempt(headers(2), 3)).toBe(true); // 3rd of 3
  });
});
