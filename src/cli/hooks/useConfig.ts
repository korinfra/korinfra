import { useState, useEffect, useCallback } from 'react';

import { loadConfig } from '../../config/index.js';
import type { Config } from '../../config/index.js';

interface UseConfigResult {
  config: Config | null;
  error: string | null;
  isLoading: boolean;
  /** Reload configuration from disk (e.g. after init creates a new config file). */
  reload: () => void;
}

export function useConfig(): UseConfigResult {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadKey, setLoadKey] = useState(0);

  const reload = useCallback(() => {
    setIsLoading(true);
    setError(null);
    setConfig(null);
    setLoadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const CONFIG_TIMEOUT_MS = 10_000;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Config load timed out after 10s')), CONFIG_TIMEOUT_MS);
    });

    Promise.race([loadConfig(), timeout])
      .then((cfg) => {
        if (!cancelled) {
          setConfig(cfg);
          setIsLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          const errCode = (err as NodeJS.ErrnoException).code;
          if (errCode === 'ENOENT' || msg.includes('ENOENT') || msg.includes('no such file')) {
            setError('No config file found. Use init to create one.');
          } else {
            setError(msg);
          }
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [loadKey]);

  return { config, error, isLoading, reload };
}
