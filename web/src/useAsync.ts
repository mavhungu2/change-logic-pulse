import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

export type AsyncState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: ApiError }
  | { readonly status: 'ready'; readonly data: T };

/**
 * Loading and error states for a fetch, in one place.
 *
 * CLAUDE.md requires both on every async call; a hook is how that stops being a
 * thing each screen has to remember. A screen renders three cases or it does not
 * compile — there is no fourth state where data is silently undefined.
 */
export function useAsync<T>(
  run: () => Promise<T>,
  deps: readonly unknown[],
): { state: AsyncState<T>; reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const callback = useCallback(run, deps);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    callback()
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          error:
            error instanceof ApiError ? error : new ApiError(0, null, (error as Error).message),
        });
      });

    // Stops a slow response from a previous survey overwriting the current one.
    return () => {
      cancelled = true;
    };
  }, [callback, attempt]);

  return { state, reload: () => setAttempt((value) => value + 1) };
}
