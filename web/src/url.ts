/**
 * The URL as a resource address, without a router.
 *
 * One parameter:
 *
 *   ?survey=<uuid>   which survey a manager is reading
 *
 * ── What is deliberately not here ──────────────────────────────────────────
 *
 * There is no organization, and there is no user.
 *
 * No organization, because the tenant is not the caller's to choose: it is a
 * claim in a token the server signed, and every query is scoped to it by the
 * database rather than by anything the browser sends. Paste another
 * organization's survey id into `?survey=` and the summary answers 404 — the
 * same answer as an id that never existed, because from inside this tenant
 * those two cases are indistinguishable.
 *
 * That is worth doing on purpose in front of someone. The address bar is the
 * most obvious place a person would try to reach data that is not theirs, and
 * the only thing there to edit is which survey — never whose.
 *
 * No user, because identity is a session and not a place. Signing in is a login
 * and signing out is a logout; neither is a navigation, and a URL that carried
 * the current user would make the back button a privilege change. A survey
 * summary is a resource and has an address. Who is reading it is not part of
 * that address — it is who you are, and the token says so.
 */

export type UrlParam = 'survey';

/** Everything this app defines. Anything else in the query string is not ours. */
const KNOWN: readonly UrlParam[] = ['survey'];

/** The current value of a parameter, or null when absent or empty. */
export function readParam(name: UrlParam): string | null {
  const value = new URLSearchParams(window.location.search).get(name);
  return value === null || value.trim() === '' ? null : value.trim();
}

/**
 * Rewrites the query string from the parameters this app defines, with `patch`
 * applied on top. `null` removes one.
 *
 * Rebuilt rather than patched in place, so the address bar only ever holds
 * parameters that mean something here. An earlier version of this app carried
 * the signed-in user in the URL; a link from then would otherwise keep naming a
 * user long after the app stopped reading it, and a URL that describes a session
 * it is not driving is worse than one that says nothing.
 *
 * replaceState rather than pushState: changing which survey you are reading is
 * not a navigation anyone wants to walk back through with the Back button. The
 * address bar still updates, so the link is always copyable.
 */
export function writeParams(patch: Partial<Record<UrlParam, string | null>>): void {
  const current = new URLSearchParams(window.location.search);
  const params = new URLSearchParams();

  for (const name of KNOWN) {
    const value = current.get(name);
    if (value !== null) params.set(name, value);
  }

  for (const [name, value] of Object.entries(patch)) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }

  const query = params.toString();
  window.history.replaceState(null, '', query === '' ? window.location.pathname : `?${query}`);
}
