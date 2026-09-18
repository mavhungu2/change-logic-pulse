import { useEffect, useState } from 'react';
import type { MeView } from '@api/tenancy/contract.js';
import { ApiError, api } from './api';
import { ErrorPanel, Loading } from './Feedback';
import { Login } from './Login';
import { ManagerFlow } from './ManagerFlow';
import { MemberFlow } from './MemberFlow';
import { readParam, writeParams } from './url';
import { useAsync } from './useAsync';

function SignedIn({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const { state, reload } = useAsync(() => api<MeView>('/me', { token }), [token]);

  if (state.status === 'loading') return <Loading what="your account" />;
  if (state.status === 'error') {
    return (
      <>
        <ErrorPanel message={state.error.message} onRetry={reload} />
        <button type="button" onClick={onSignOut}>
          Sign in as someone else
        </button>
      </>
    );
  }

  const me = state.data;
  return (
    <>
      <header className="topbar">
        <div>
          {/* The organization is read from /me — which is to say from the token
              the server signed, never from the URL. Two tabs showing two
              different names here are two tenants, not two routes. */}
          <strong>{me.org.name}</strong>
          <span className="muted">
            {' '}
            · {me.name} ({me.role})
          </span>
        </div>
        <button type="button" onClick={onSignOut}>
          Switch user
        </button>
      </header>

      {/* The role decides the flow. The API enforces it regardless of what is
          rendered — these routes are a convenience, not the access control. */}
      {me.role === 'manager' ? <ManagerFlow token={token} /> : <MemberFlow token={token} />}
    </>
  );
}

export default function App() {
  // Deliberately in memory, not localStorage: a bearer token in storage is
  // readable by any script on the page. What survives a refresh is `?as=` in
  // the URL, which is an email and not a credential — the token is fetched
  // again through the ordinary login. See url.ts.
  const [token, setToken] = useState<string | null>(null);
  const [as, setAs] = useState<string | null>(() => readParam('as'));
  const [autoFailure, setAutoFailure] = useState<ApiError | null>(null);

  // A link that names a user signs in as that user, so two tabs can hold two
  // organizations at once and a reload lands where it left off.
  useEffect(() => {
    if (token !== null || as === null || autoFailure !== null) return;

    let cancelled = false;
    api<{ accessToken: string }>('/auth/login', { method: 'POST', body: { email: as } })
      .then(({ accessToken }) => {
        if (!cancelled) setToken(accessToken);
      })
      .catch((error: unknown) => {
        // A ?as= naming somebody who is not seeded, or a dev login that is
        // switched off, falls back to the picker rather than to a blank page.
        if (!cancelled) setAutoFailure(error as ApiError);
      });

    return () => {
      cancelled = true;
    };
  }, [as, token, autoFailure]);

  function signIn(accessToken: string, email: string) {
    setToken(accessToken);
    setAs(email);
    setAutoFailure(null);
    writeParams({ as: email, survey: null });
  }

  function signOut() {
    setToken(null);
    setAs(null);
    setAutoFailure(null);
    writeParams({ as: null, survey: null });
  }

  if (token !== null) {
    return (
      <main>
        <h1>Pulse Surveys</h1>
        <SignedIn token={token} onSignOut={signOut} />
      </main>
    );
  }

  return (
    <main>
      <h1>Pulse Surveys</h1>
      {as !== null && autoFailure === null ? (
        <Loading what={as} />
      ) : (
        <Login onSignedIn={signIn} failure={autoFailure} />
      )}
    </main>
  );
}
