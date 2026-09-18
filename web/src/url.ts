/**
 * The URL as navigable state, without a router.
 *
 * Two parameters, and their shape is the point:
 *
 *   ?as=<seeded email>   who to sign in as
 *   ?survey=<uuid>       which survey a manager is reading
 *
 * ── There is deliberately no organization in either ────────────────────────
 *
 * A caller cannot name a tenant, because the tenant is not the caller's to
 * choose. It is a claim in a token the server signed, and every query is scoped
 * to it by the database rather than by anything the browser sends. Paste another
 * organization's survey id into `?survey=` and the summary answers 404 — the
 * same answer as an id that never existed, because from inside this tenant those
 * two cases are indistinguishable.
 *
 * That is worth doing on purpose in front of someone. The address bar is the
 * most obvious place a user would try to reach data that is not theirs, and
 * there is nothing to type.
 *
 * ── `?as=` is an identity hint, never a credential ─────────────────────────
 *
 * It carries the email, and the app exchanges that for a token through the
 * ordinary `POST /auth/login`. A token in the URL would be a bearer credential
 * sitting in browser history, in the referrer header, and in every log between
 * here and its destination.
 *
 * It grants nothing the login picker does not already grant: that endpoint
 * issues a valid token for any seeded email with no password, and it is 404
 * unless ENABLE_DEV_LOGIN is on — so this disappears with the dev login it
 * depends on, rather than outliving it.
 */

export type UrlParam = 'as' | 'survey';

/** The current value of a parameter, or null when absent or empty. */
export function readParam(name: UrlParam): string | null {
  const value = new URLSearchParams(window.location.search).get(name);
  return value === null || value.trim() === '' ? null : value.trim();
}

/**
 * Applies a patch to the query string. `null` removes a parameter.
 *
 * replaceState rather than pushState: switching user or survey is not a
 * navigation anyone wants to walk back through with the Back button, and a demo
 * that has to press Back eleven times to leave is a worse demo. The address bar
 * still updates, so the link is always copyable.
 */
export function writeParams(patch: Partial<Record<UrlParam, string | null>>): void {
  const params = new URLSearchParams(window.location.search);

  for (const [name, value] of Object.entries(patch)) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }

  const query = params.toString();
  window.history.replaceState(null, '', query === '' ? window.location.pathname : `?${query}`);
}
