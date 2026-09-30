// What the web app may send the extension (externally_connectable), and what it answers. Anything else is
// refused. The pages allowed to send are the build's web origins, checked on every message.
import { config } from '../config';
import { hello, link, type Deps } from './link';
import { readSession, signOut } from './session';

export type ExternalMessage =
  | { type: 'hello' }
  | { type: 'link'; code: string }
  | { type: 'status' }
  // The web app signed out: so does the extension (ADR 0002 §3, step 5).
  | { type: 'sign-out' };

/** The message, if it's exactly one of the four; null for anything else. */
export function parseMessage(m: unknown): ExternalMessage | null {
  if (typeof m !== 'object' || m === null) return null;
  const { type, code, ...rest } = m as { type?: unknown; code?: unknown };
  if (Object.keys(rest).length) return null;
  if (type === 'link') return typeof code === 'string' && code.length >= 1 && code.length <= 128 ? { type, code } : null;
  if (code !== undefined) return null;
  return type === 'hello' || type === 'status' || type === 'sign-out' ? { type } : null;
}

export type Answer =
  | { ok: true; [k: string]: unknown }
  | { ok: false; error: string };

export async function handleExternal(deps: Deps, message: unknown, sender: chrome.runtime.MessageSender): Promise<Answer> {
  if (!sender.origin || !config.webOrigins.includes(sender.origin)) return { ok: false, error: 'origin' };
  const m = parseMessage(message);
  if (!m) return { ok: false, error: 'invalid' };
  switch (m.type) {
    case 'hello':
      return hello(deps);
    case 'link':
      return link(deps, m.code);
    case 'status': {
      const session = await readSession(deps);
      return { ok: true, signedIn: !!session, version: config.version };
    }
    case 'sign-out':
      await signOut(deps);
      return { ok: true };
  }
}
