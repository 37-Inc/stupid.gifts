import {createContentAdminHandler} from './content-admin.ts';
import {applyRuntimeCollection} from '../../lib/catalog/runtime-collections.ts';
import type {RuntimeSiteEnv} from './runtime-site.tsx';
import type {RuntimeCatalogView} from './runtime-data.ts';
import type {SiteReleaseIdentity} from './index.ts';
import type {SiteAssetManifest} from '../../lib/catalog/types.ts';
import {SHOW_PRESETS,ACTIVE_SHOW_PRESET,selectShowPicks} from '../../static-site/lib/show-rehearsal.ts';

export async function runtimeAdminRequest(request:Request,env:RuntimeSiteEnv,view:RuntimeCatalogView,identity:SiteReleaseIdentity){
  if(!new URL(request.url).pathname.startsWith('/api/content-admin'))return;
  if(env.CONTENT_ADMIN_ENABLED!=='true')return Response.json({error:'not_found'},{status:404,headers:{'Cache-Control':'no-store'}});
  const {data}=view,showCollections:Record<string,string[]>={};
  for(const name of Object.keys(SHOW_PRESETS))showCollections[name]=selectShowPicks(data.snapshot,name as keyof typeof SHOW_PRESETS).map(p=>p.publicId);
  for(const [key,value]of Object.entries(view.collections))if(key.startsWith('/collections/')&&key!=='/collections/homepage'){
    const payload=value.payload as {ids?:string[]};if(Array.isArray(payload.ids))showCollections[key.slice(13)]=payload.ids;
  }
  const active=(view.collections['/active-show']?.payload as {name?:string})?.name??ACTIVE_SHOW_PRESET;
  const manifest={schemaVersion:1,releaseId:identity.release_id,codeSha:identity.code_sha,catalogRevision:view.head.catalogRevision,
    catalogSnapshotSha256:view.head.snapshotSha256,dataKind:'catalog',generatedAt:data.snapshot.generatedAt,nextExpiry:null,
    vectorSyncWatermark:0,productCount:data.snapshot.products.length,slugCount:data.snapshot.products.length,priorReleaseId:null,checksums:{},routes:{},
    homepage:(view.collections['/collections/homepage']?.payload as {edition?:SiteAssetManifest['homepage']})?.edition??data.homepage,
    merchandising:data.merchandising} as SiteAssetManifest;
  return createContentAdminHandler({snapshot:data.snapshot,manifest,releaseIdentity:identity,showCollections,activeShow:active,now:Date.now,
    applyCollection:saved=>applyRuntimeCollection(env.DB,saved),readApplication:async id=>{
      const row=(await env.DB.prepare('SELECT state,result_json FROM content_admin_results WHERE request_id=?').bind(id).all<{state:string;result_json:string}>()).results[0];
      return row?{state:row.state,result:JSON.parse(row.result_json)}:null;
    }})(request,env);
}
