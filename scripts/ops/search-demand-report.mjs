import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Fixed SELECT only: topics and ratios, never per-search IDs or visitor records. */
export function searchDemandReportSql(days = 7) {
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('days must be 1..30');
  return `SELECT topic, COUNT(*) AS observations,
    SUM(outcome='results') AS completed_searches,
    SUM(outcome='unavailable') AS unavailable_searches,
    SUM(outcome='results' AND result_count=0) AS zero_result_searches,
    SUM(outcome='results' AND result_count BETWEEN 1 AND 3) AS sparse_searches,
    ROUND(100.0*SUM(outcome='results' AND result_count=0)/NULLIF(SUM(outcome='results'),0),1) AS zero_result_rate_pct,
    ROUND(100.0*SUM(outcome='results' AND result_count BETWEEN 1 AND 3)/NULLIF(SUM(outcome='results'),0),1) AS sparse_result_rate_pct,
    ROUND(AVG(result_count),2) AS average_results_shown,
    SUM(selected_rank IS NOT NULL) AS searches_with_selection,
    ROUND(100.0*SUM(selected_rank IS NOT NULL)/NULLIF(SUM(outcome='results' AND result_count>0),0),1) AS selection_rate_pct,
    ROUND(AVG(selected_rank),2) AS average_selected_rank, MAX(day) AS latest_utc_day
    FROM search_demand
    WHERE expires_at>unixepoch() AND day>=date('now','-${days - 1} days')
    GROUP BY topic ORDER BY observations DESC,topic LIMIT 50`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let days = 7, local = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--local') local = true;
    else if (args[i] === '--days' && /^\d+$/.test(args[i + 1] ?? '')) days = Number(args[++i]);
    else throw new Error('Usage: npm run searches:report -- [--days 1..30] [--local]');
  }
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const sql = searchDemandReportSql(days);
  const result = execFileSync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'),
    'd1', 'execute', 'DB', '--config', path.join(root, 'wrangler.production.jsonc'),
    local ? '--local' : '--remote', '--json', '--command', sql], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  console.log(result.trim());
}
