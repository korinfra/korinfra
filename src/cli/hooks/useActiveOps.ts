import { createContext, useContext } from 'react';

/**
 * Track in-flight AI / scan operations so the global `q` handler can show a
 * confirmation prompt before aborting them.
 *
 * The App component owns the provider. Command components call
 * registerOp / unregisterOp to signal when a long-running operation is active.
 *
 * Usage in a command:
 *   const { registerOp, unregisterOp } = useActiveOps();
 *   useEffect(() => {
 *     if (!isRunning) return;
 *     const id = registerOp('scan');
 *     return () => unregisterOp(id);
 *   }, [isRunning, registerOp, unregisterOp]);
 */

export interface ActiveOpsContextValue {
  /** Current count of running operations. */
  count: number;
  /**
   * Register a named operation. Returns an opaque ID to pass to unregisterOp.
   */
  registerOp: (name: string) => string;
  /** Unregister a previously registered operation by ID. */
  unregisterOp: (id: string) => void;
}

export const ActiveOpsContext = createContext<ActiveOpsContextValue>({
  count: 0,
  registerOp: () => '',
  unregisterOp: () => {},
});

export function useActiveOps(): ActiveOpsContextValue {
  return useContext(ActiveOpsContext);
}
