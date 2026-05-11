/**
 * useToast — ephemeral notification state for TUI screens.
 *
 * Manages a capped queue of at most 3 toasts. Auto-expires info/success
 * toasts after 3 s; error/warning toasts persist until manually dismissed.
 *
 * When the cap is reached, the oldest non-error toast is evicted to make room.
 * If all visible toasts are errors, the new toast is dropped.
 *
 * Usage:
 *   const { toasts, show, dismiss } = useToast();
 *   show({ level: 'success', message: 'Copied!' });
 */

import { useState, useEffect, useRef } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type ToastLevel = 'info' | 'success' | 'warning' | 'error';

interface Toast {
  id: string;
  level: ToastLevel;
  message: string;
  /**
   * Auto-dismiss after this many ms.
   * Defaults to 3000 for info/success; 0 (no auto-dismiss) for warning/error.
   */
  duration?: number;
}

interface UseToastReturn {
  toasts: Toast[];
  show: (toast: Omit<Toast, 'id'>) => string;
  dismiss: (id: string) => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_TOASTS = 3;
const DEFAULT_DURATION_MS = 3000;
const PERSISTENT_LEVELS: ToastLevel[] = ['warning', 'error'];

function defaultDuration(level: ToastLevel): number {
  return PERSISTENT_LEVELS.includes(level) ? 0 : DEFAULT_DURATION_MS;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useToast(): UseToastReturn {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Track active timers so we can cancel them on dismiss / unmount
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Cleanup all pending timers on unmount
  useEffect(() => {
    const timersToClean = timers.current;
    return () => {
      for (const timer of timersToClean.values()) {
        clearTimeout(timer);
      }
      timersToClean.clear();
    };
  }, []);

  const dismiss = (id: string): void => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const show = (incoming: Omit<Toast, 'id'>): string => {
    const id = crypto.randomUUID();
    const duration = incoming.duration ?? defaultDuration(incoming.level);
    const toast: Toast = { ...incoming, id, duration };

    setToasts((prev) => {
      const next = [...prev];

      // Enforce cap: evict oldest non-error toast to make room
      if (next.length >= MAX_TOASTS) {
        const evictIdx = next.findIndex(
          (t) => t.level !== 'error' && t.level !== 'warning',
        );
        if (evictIdx === -1) {
          // All visible toasts are persistent — drop the new one silently
          return prev;
        }
        const evicted = next[evictIdx];
        if (!evicted) return prev;
        const timer = timers.current.get(evicted.id);
        if (timer !== undefined) {
          clearTimeout(timer);
          timers.current.delete(evicted.id);
        }
        next.splice(evictIdx, 1);
      }

      return [...next, toast];
    });

    // Schedule auto-dismiss
    if (duration > 0) {
      const timer = setTimeout(() => dismiss(id), duration);
      timers.current.set(id, timer);
    }

    return id;
  };

  return { toasts, show, dismiss };
}
