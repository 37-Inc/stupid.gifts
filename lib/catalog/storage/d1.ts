import { validatePublicCatalogProduct } from '../snapshot.ts';
import type { PublicCatalogProduct } from '../types.ts';
import { currentShortCopySql } from '../d1.ts';

/** Optional cancellation is for observation SELECTs only, never mutation IO. */
export interface D1ReadOptions { signal?: AbortSignal }
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T = Record<string, unknown>>(options?: D1ReadOptions): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface CatalogD1 {
  prepare(sql: string): D1Statement;
  /** D1 batch is atomic: a failed statement rolls back the complete batch. */
  batch(statements: D1Statement[], options?: D1ReadOptions): Promise<unknown>;
}

const READY = `p.is_active=1 AND p.duplicate_of_product_id IS NULL
  AND COALESCE(p.availability_checked_at,p.last_verified_at) IS NOT NULL
  AND p.quality_score>=0.55
  AND upper(p.availability_status) IN ('IN_STOCK','IN_STOCK_SCARCE','INSTOCKSCARCE','AVAILABLE_DATE','LEADTIME','PREORDER')
  AND p.editorial_status IN ('generated_ready','manual_locked','short_ready')
  AND p.source_facts_hash IS NOT NULL AND p.source_facts_hash=p.editorial_source_hash
  AND p.public_display_json IS NOT NULL AND p.eligible_until>?
  AND ${currentShortCopySql('p.public_display_json')}`;
function publicRows(rows: Array<{ public_display_json: string }>, now: Date): PublicCatalogProduct[] {
  return rows.flatMap((row) => {
    // One corrupt/expired product must not expose private fields or blank all search results.
    try { return [validatePublicCatalogProduct(JSON.parse(row.public_display_json), now)]; }
    catch { return []; }
  });
}

export async function getProductsByPublicIds(db: CatalogD1, ids: string[], now = new Date(), revision?: string): Promise<PublicCatalogProduct[]> {
  if (ids.length > 240) throw new Error('Candidate limit is 240');
  const unique = [...new Set(ids)];
  const found = new Map<string, PublicCatalogProduct>();
  for (let offset = 0; offset < unique.length; offset += 80) {
    const batch = unique.slice(offset, offset + 80);
    // CROSS JOIN fixes the bounded ID set as the outer loop. Without it SQLite
    // can prefer the broad active/quality index and scan thousands of held rows.
    const result = await db.prepare(`WITH requested(public_id) AS (VALUES ${batch.map(() => '(?)').join(',')})
      SELECT p.public_display_json FROM requested
      CROSS JOIN products p ON p.public_id=requested.public_id
      LEFT JOIN catalog_maintenance_products m ON m.product_id=p.id
      WHERE ${READY}${revision ? ' AND p.catalog_revision=?' : ''}`)
      .bind(...batch, now.toISOString(), ...(revision ? [revision] : [])).all<{ public_display_json: string }>();
    for (const product of publicRows(result.results, now)) found.set(product.publicId, product);
  }
  return unique.flatMap((id) => found.has(id) ? [found.get(id)!] : []);
}

export async function keywordSearch(db: CatalogD1, query: string, limit = 60, now = new Date(), revision?: string): Promise<PublicCatalogProduct[]> {
  const normalized = query.normalize('NFKC').trim();
  if (normalized.length < 2 || normalized.length > 200) return [];
  if (!Number.isInteger(limit) || limit < 1 || limit > 240) throw new Error('Candidate limit must be 1..240');
  // Quote words rather than accepting FTS operators or a caller-supplied MATCH expression.
  const words = normalized.match(/[\p{L}\p{N}]+/gu)?.slice(0, 20) || [];
  if (!words.length) return [];
  const match = words.map((word) => `"${word}"`).join(' OR ');
  const result = await db.prepare(`SELECT p.public_display_json FROM products_fts
    CROSS JOIN products p ON p.rowid=products_fts.rowid
    LEFT JOIN catalog_maintenance_products m ON m.product_id=p.id
    WHERE products_fts MATCH ? AND ${READY}${revision ? ' AND p.catalog_revision=?' : ''}
    ORDER BY bm25(products_fts),p.public_id LIMIT ?`)
    .bind(match, now.toISOString(), ...(revision ? [revision] : []), limit).all<{ public_display_json: string }>();
  return publicRows(result.results, now);
}

export interface SearchDiagnostic {
  id: string; queryHash: string; queryLength: number; resultCount: number;
  topSimilarity: number | null; matchType: 'semantic' | 'keyword' | 'none';
  outcome: 'ok' | 'empty' | 'unavailable';
}
/** Hash-only, 30-day diagnostics. The caller treats failure as non-fatal. */
export async function appendSearchDiagnostic(db: CatalogD1, event: SearchDiagnostic, now = new Date()): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(event.queryHash) || event.queryLength < 2 || event.queryLength > 200
    || !Number.isInteger(event.queryLength) || !Number.isInteger(event.resultCount)
    || event.resultCount < 0 || event.resultCount > 60
    || (event.topSimilarity !== null && (!Number.isFinite(event.topSimilarity) || Math.abs(event.topSimilarity) > 1))) {
    throw new Error('Invalid search diagnostic');
  }
  // The same atomic batch gates cleanup AND insertion. A provider/diagnostic
  // callback begun before capture cannot write after ownership was acquired.
  const unowned="NOT EXISTS(SELECT 1 FROM catalog_mutation_scopes WHERE phase!='idle')";
  await db.batch([
    db.prepare(`SELECT json(CASE WHEN ${unowned} THEN 'true' ELSE 'catalog_runtime_owned' END)`),
    db.prepare(`DELETE FROM search_diagnostics WHERE expires_at<=? AND ${unowned}`).bind(now.toISOString()),
    db.prepare(`INSERT INTO search_diagnostics
      (id,query_hash,query_length,result_count,top_similarity,match_type,outcome,created_at,expires_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${unowned}`).bind(event.id, event.queryHash, event.queryLength, event.resultCount,
      event.topSimilarity, event.matchType, event.outcome, now.toISOString(), new Date(now.getTime() + 30 * 86400000).toISOString()),
  ]);
}
