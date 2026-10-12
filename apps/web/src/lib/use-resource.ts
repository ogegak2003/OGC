import { useCallback, useEffect, useState } from 'react';

export type Resource<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: unknown };

/**
 * Loads data when the component mounts or `load` changes, cancelling stale
 * requests. `load` must be stable (wrap it in `useCallback`). `reload` refetches;
 * `set` replaces the data after a mutation returned the new state.
 */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<Resource<T>>({ status: 'loading' });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', error });
      },
    );
    return () => {
      controller.abort();
    };
  }, [load, version]);

  const reload = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);
  const set = useCallback((data: T) => {
    setState({ status: 'ready', data });
  }, []);

  return { state, reload, set };
}
