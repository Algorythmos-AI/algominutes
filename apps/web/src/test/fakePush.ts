import { vi } from 'vitest';
import type { ForegroundMessage, PushMessaging, PushPermission } from '../lib/push/messaging';

/** A PushMessaging with the browser's permission set by the test. */
export function fakePush(initial: PushPermission = 'default', answer: NotificationPermission = 'granted') {
  let permission: PushPermission = initial;
  let listener: ((m: ForegroundMessage) => void) | null = null;
  const messaging: PushMessaging = {
    permission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => {
      permission = answer;
      return answer;
    }),
    token: vi.fn(async () => 'fcm-token-1'),
    deleteToken: vi.fn(async () => {}),
    onOpenNote: vi.fn(() => () => {}),
    onForeground: vi.fn((cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
  };
  return { messaging, deliver: (m: ForegroundMessage) => listener?.(m) };
}
