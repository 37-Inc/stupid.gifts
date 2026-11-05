import { searchDemandTopic } from './search-demand';
import type { SearchDemandObservation } from './search-demand';

/** No browser storage or identity. Timer/send injection makes cancellation testable. */
export function createSearchDemandTracker(options: {
  isAllowed(): boolean;
  id(): string;
  send(observation: SearchDemandObservation): void;
  later(callback: () => void, ms: number): number;
  cancel(timer: number): void;
}) {
  let current: { query: string; explicit: boolean; observation?: SearchDemandObservation; sent: boolean } | undefined;
  let timer: number | undefined;
  function allowed() { try { return options.isAllowed(); } catch { return false; } }
  function cancelTimer() {
    if (timer !== undefined) { try { options.cancel(timer); } catch {} }
    timer = undefined;
  }
  function flush() {
    cancelTimer();
    if (!current?.observation || current.sent || !allowed()) return;
    current.sent = true;
    try { options.send({ ...current.observation }); } catch { /* Never affect search. */ }
  }
  function edit() { cancelTimer(); current = undefined; }
  return {
    edit,
    dispose: edit,
    begin(query: string, explicit = false) {
      cancelTimer();
      const topic = searchDemandTopic(query);
      // Parent analytics readiness can settle after a bookmarked search starts.
      // Only completion/dispatch needs permission; the UI already holds this text.
      if (!topic) { current = undefined; return; }
      if (current?.query !== topic || current.observation?.outcome === 'unavailable')
        current = { query: topic, explicit, sent: false };
      else current.explicit ||= explicit;
    },
    complete(resultCount: number | null) {
      if (!current || current.sent) return;
      if (!allowed()) { edit(); return; }
      cancelTimer();
      let id: string;
      try { id = options.id(); } catch { edit(); return; }
      current.observation = { schemaVersion: 1, id, topic: current.query,
        outcome: resultCount === null ? 'unavailable' : 'results', resultCount, selectedRank: null };
      if (current.explicit) flush();
      else { try { timer = options.later(flush, 1500); } catch { edit(); } }
    },
    select(rank: number) {
      const observation = current?.observation;
      if (!observation || observation.outcome !== 'results' || observation.selectedRank !== null
        || !Number.isInteger(rank) || rank < 1 || rank > observation.resultCount! || !allowed()) return;
      observation.selectedRank = rank;
      // If the settled event already went out, this updates the SAME anonymous
      // search row. Otherwise one combined observation is sufficient.
      if (current!.sent) {
        try { options.send({ ...observation }); } catch { /* Native navigation continues. */ }
      } else flush();
    },
  };
}
