"use client";

import { createSearchDemandTracker } from '../../lib/search-demand-tracker';
import { isSearchDemandAllowed } from './analytics';

export function createBrowserSearchDemand() {
  return createSearchDemandTracker({
    isAllowed: isSearchDemandAllowed,
    id: () => crypto.randomUUID(),
    later: (callback, ms) => window.setTimeout(callback, ms),
    cancel: timer => window.clearTimeout(timer),
    send: observation => {
      // Independent, best effort and same-origin. No cookies or query-bearing
      // referrer accompany the topic, and no request is awaited by the UI.
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 2000);
      try {
        void fetch('/api/search-demand', {
          method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(observation), signal: controller.signal,
        }).catch(() => {}).finally(() => window.clearTimeout(timer));
      } catch { window.clearTimeout(timer); }
    },
  });
}
