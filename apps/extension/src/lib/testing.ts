// Fakes for the extension's tests: chrome.storage.session, fetch, and Firebase-shaped ID tokens.

export function fakeStorage(): chrome.storage.StorageArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys) {
      const ks = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch that records every call and answers from `answer`. */
export function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: init?.body === undefined ? undefined : String(init.body),
    };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { fetch: f, calls };
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** An ID token as Firebase shapes one: only its payload's `sub` is read. Built here, never a literal. */
export function idTokenFor(sub: string, n = 1): string {
  const part = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return [part({ alg: 'RS256' }), part({ sub, n }), 'signature'].join('.');
}
