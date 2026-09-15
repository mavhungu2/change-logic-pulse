import type { ReactNode } from 'react';

export const Loading = ({ what }: { what: string }) => (
  <p className="muted" role="status">
    Loading {what}…
  </p>
);

export const ErrorPanel = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className="panel error" role="alert">
    <p>{message}</p>
    {onRetry && (
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    )}
  </div>
);

/** For outcomes that are normal but not success — the 409, above all. */
export const NoticePanel = ({ children }: { children: ReactNode }) => (
  <div className="panel notice">{children}</div>
);
