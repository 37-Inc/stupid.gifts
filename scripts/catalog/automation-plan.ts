import {planProductFreshness,FRESHNESS_POLICY} from './freshness-selection.ts';
import type {FreshnessProduct,FreshnessSelection} from './freshness-selection.ts';

/** Required throughput, not a fixed supplier quota. Hot/finite-photo work and
 * unresolved negative legacy labels are immediate. Quiet rotation scales with
 * the actual catalog so the first wake is not a whole-catalog refetch. */
export function planRoutineAutomation(products:readonly FreshnessProduct[],observedAt:string,selection:FreshnessSelection={}){
  const plan=planProductFreshness(products,observedAt,selection);
  const quietPerRun=Math.ceil(plan.eligibleCount/FRESHNESS_POLICY.quietDays);
  const immediate=new Set(['photo_broken','photo_due','hot_stock_due','legacy_availability_unknown','unavailable_recheck']);
  const selected=plan.entries.filter(p=>p.reasons.some(reason=>immediate.has(reason)));
  const selectedIds=new Set(selected.map(p=>p.id));
  for(const entry of plan.entries.filter(p=>!selectedIds.has(p.id)).slice(0,quietPerRun))selectedIds.add(entry.id);
  return{plan,refreshIds:plan.entries.filter(p=>selectedIds.has(p.id)).map(p=>p.id),quietPerRun};
}
