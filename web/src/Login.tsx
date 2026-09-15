import { useState } from 'react';
import { ApiError, api } from './api';
import { ErrorPanel } from './Feedback';

/**
 * The seeded addresses, hardcoded.
 *
 * The alternative — an endpoint listing users to populate this — would have to
 * return people from every organization, which is a hole in tenant isolation
 * opened to serve a development convenience. CLAUDE.md §5 asks only for a
 * dropdown of seeded users; this is that, and it costs the product nothing.
 */
const SEEDED_USERS = [
  { email: 'manager@northwind.test', label: 'Northwind Logistics — Manager' },
  { email: 'member1@northwind.test', label: 'Northwind Logistics — Member 1' },
  { email: 'member2@northwind.test', label: 'Northwind Logistics — Member 2' },
  { email: 'manager@seabird.test', label: 'Seabird Studios — Manager' },
  { email: 'member1@seabird.test', label: 'Seabird Studios — Member 1' },
  { email: 'member3@seabird.test', label: 'Seabird Studios — Member 3 (has not answered)' },
];

export function Login({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [email, setEmail] = useState(SEEDED_USERS[0].email);
  const [status, setStatus] = useState<'idle' | 'signing-in'>('idle');
  const [error, setError] = useState<ApiError | null>(null);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setStatus('signing-in');
    setError(null);
    try {
      const { accessToken } = await api<{ accessToken: string }>('/auth/login', {
        method: 'POST',
        body: { email },
      });
      onSignedIn(accessToken);
    } catch (caught) {
      setError(caught as ApiError);
      setStatus('idle');
    }
  }

  return (
    <form className="card" onSubmit={signIn}>
      <h2>Sign in</h2>
      <p className="muted">
        Development only — no password. Pick a seeded user; switching users switches
        organization.
      </p>

      <label htmlFor="user">User</label>
      <select id="user" value={email} onChange={(event) => setEmail(event.target.value)}>
        {SEEDED_USERS.map((user) => (
          <option key={user.email} value={user.email}>
            {user.label}
          </option>
        ))}
      </select>

      {error && <ErrorPanel message={error.message} />}

      <button type="submit" disabled={status === 'signing-in'}>
        {status === 'signing-in' ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
