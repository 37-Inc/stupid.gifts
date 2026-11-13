import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import type {PublicationIntent} from '../../lib/catalog/publication.ts';
type Row=Record<string,unknown>;

/** A catalog receipt can be delivered by a Worker version OR runtime data.
 * Callers still verify the exact receipt/build/native history and CAS returned
 * runtime rows. Historical data publications need not be the current head. */
export async function readResolvedPublicationTransport(db:CatalogD1,build:Row,publication:Row,intent:PublicationIntent,
  errorCode:string,signal?:AbortSignal):Promise<Row|undefined>{
  const fail=():never=>{throw Error(errorCode);};
  if(build.state!=='resolved'||publication.state!=='verified'||build.release_id!==intent.releaseId
    ||publication.release_id!==intent.releaseId)fail();
  if(build.version_reference!==null){
    if(typeof build.version_reference!=='string'||!/^[a-zA-Z0-9._:/-]{1,200}$/.test(build.version_reference)
      ||typeof publication.dispatch_reference!=='string'||!/^[a-zA-Z0-9._:/-]{1,200}$/.test(publication.dispatch_reference))fail();
    return;
  }
  const rows=(await db.prepare('SELECT * FROM catalog_runtime_publications WHERE release_id=?').bind(intent.releaseId).all<Row>({signal})).results;
  const runtime=rows[0];
  if(rows.length!==1||runtime.request_id!==build.request_id||runtime.catalog_revision!==intent.catalogRevision
    ||runtime.data_sha256!==intent.manifestSha256||!/^[a-f0-9]{64}$/.test(String(runtime.data_sha256))
    ||runtime.source_snapshot_sha256!==intent.catalogSnapshotSha256||runtime.previous_release_id!==intent.priorReleaseId
    ||build.dispatch_reference!==`runtime:${runtime.data_sha256}`||publication.dispatch_reference!==build.dispatch_reference)fail();
  return runtime;
}
