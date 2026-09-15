import { useState } from 'react';
import type { MeView } from '@api/tenancy/contract.js';
import { api } from './api';
import { ErrorPanel, Loading } from './Feedback';
import { Login } from './Login';
import { ManagerFlow } from './ManagerFlow';
import { MemberFlow } from './MemberFlow';
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
  // readable by any script on the page, and a refresh returning to the picker
  // is no hardship for a development-only sign-in.
  const [token, setToken] = useState<string | null>(null);

  return (
    <main>
      <h1>Pulse Surveys</h1>
      {token === null ? (
        <Login onSignedIn={setToken} />
      ) : (
        <SignedIn token={token} onSignOut={() => setToken(null)} />
      )}
    </main>
  );
}
