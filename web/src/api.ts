const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';

/** Carries the status and parsed body so callers can tell 409 from a failure. */
export class ApiError extends Error {
  // Written out rather than as constructor parameter properties: the Vite
  // template enables erasableSyntaxOnly, which rules those out.
  readonly status: number;
  readonly body: Record<string, unknown> | null;

  constructor(status: number, body: Record<string, unknown> | null, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export async function api<T>(
  path: string,
  options: { token?: string; method?: string; body?: unknown } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    // fetch only rejects when the request never happened — the API is down, or
    // CORS refused it. Worth its own message; "Failed to fetch" helps nobody.
    throw new ApiError(0, null, `Could not reach the API at ${BASE_URL}. Is it running?`);
  }

  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;

  if (!response.ok) {
    const message = typeof body?.message === 'string' ? body.message : response.statusText;
    throw new ApiError(response.status, body, message);
  }
  return body as T;
}
