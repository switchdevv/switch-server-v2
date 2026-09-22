import type { TestServer } from './server.js';

export interface ParseResponse<T = unknown> {
  status: number;
  body: T & { code?: number; error?: string; result?: unknown };
}

/** A thin Parse REST client, the way the apps and dashboards talk to the server. */
export function client(server: TestServer) {
  async function request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    opts: { session?: string; master?: boolean } = {},
  ): Promise<ParseResponse<T>> {
    const headers: Record<string, string> = {
      'X-Parse-Application-Id': server.appId,
      'Content-Type': 'application/json',
    };
    if (opts.session) headers['X-Parse-Session-Token'] = opts.session;
    if (opts.master) headers['X-Parse-Master-Key'] = server.masterKey;
    const res = await fetch(server.url + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as ParseResponse<T>['body'] };
  }

  const api = {
    request,
    /** POST /functions/<name>; resolves the whole envelope ({ result } or { code, error }). */
    fn: (name: string, params: Record<string, unknown> = {}, session?: string) =>
      request('POST', `/functions/${name}`, params, { session }),
    create: async (className: string, data: Record<string, unknown>) => {
      const res = await request<{ objectId: string }>('POST', `/classes/${className}`, data, {
        master: true,
      });
      if (res.status !== 201)
        throw new Error(`create ${className} failed: ${JSON.stringify(res.body)}`);
      return res.body.objectId;
    },
    get: async (className: string, id: string, include?: string) => {
      const qs = include ? `?include=${include}` : '';
      const path = className === '_User' ? `/users/${id}${qs}` : `/classes/${className}/${id}${qs}`;
      const res = await request<Record<string, unknown>>('GET', path, undefined, { master: true });
      return res.status === 200 ? res.body : undefined;
    },
    update: async (className: string, id: string, data: Record<string, unknown>) => {
      const path = className === '_User' ? `/users/${id}` : `/classes/${className}/${id}`;
      const res = await request('PUT', path, data, { master: true });
      if (res.status !== 200)
        throw new Error(`update ${className} failed: ${JSON.stringify(res.body)}`);
    },
    find: async (className: string, where: Record<string, unknown> = {}) => {
      const path = className === '_User' ? '/users' : `/classes/${className}`;
      const res = await request<{ results: Record<string, unknown>[] }>(
        'GET',
        `${path}?where=${encodeURIComponent(JSON.stringify(where))}&limit=1000`,
        undefined,
        { master: true },
      );
      return res.body.results;
    },
    /** Sign up through /users (as the apps do) and return { id, session }. */
    signUp: async (data: Record<string, unknown>) => {
      const res = await request<{ objectId: string; sessionToken: string }>('POST', '/users', data);
      if (res.status !== 201) throw new Error(`signUp failed: ${JSON.stringify(res.body)}`);
      return { id: res.body.objectId, session: res.body.sessionToken };
    },
  };
  return api;
}

export type Client = ReturnType<typeof client>;

export const ptr = (className: string, objectId: string) => ({
  __type: 'Pointer',
  className,
  objectId,
});
export const geo = (latitude: number, longitude: number) => ({
  __type: 'GeoPoint',
  latitude,
  longitude,
});

/** Wait until `check` returns truthy (for the fire-and-forget parts: pushes, dispatch rounds). */
export async function eventually<T>(check: () => T | Promise<T>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() - start > timeoutMs)
      throw last instanceof Error ? last : new Error('eventually: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
