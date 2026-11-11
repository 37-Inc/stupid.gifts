import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import autoprefixer from 'autoprefixer';

const ROOT=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// The runtime data exporter materializes presentation reviews. No reviewed
// product literals or supplier bytes belong in either app bundle.
const runtimePresentation=`
export const productDisplayTitle=p=>p.title;
export const productShortDescription=p=>p.description?.trim()||p.wittyDescription?.trim()||p.title;
export const productPresentation=p=>({...p});
export const hasRepairedSemanticCopy=p=>false;
export const canonicalDescriptionEmbeddingInput=p=>[p.title,p.description].filter(Boolean).join('. ');
export const sameProductTitle=(a,b)=>a.normalize('NFKC').toLowerCase().replace(/[™®]/g,'').replace(/\\s+/g,' ').trim()===b.normalize('NFKC').toLowerCase().replace(/[™®]/g,'').replace(/\\s+/g,' ').trim();
export const refreshedShortCopy=(p,t)=>sameProductTitle(t,p.title)?productShortDescription(p):t.trim().replace(/[.!?]+$/,'')+'.';`;
const presentationPlugin={name:'runtime-public-presentation',setup(builder){
  builder.onLoad({filter:/[/\\]lib[/\\]catalog[/\\]presentation\.ts$/},()=>({contents:runtimePresentation,loader:'ts'}));
  // The pure guide schema needs only its canonical origin, not Next metadata
  // or the static OG generator's build-time Node hashing implementation.
  builder.onLoad({filter:/[/\\]static-site[/\\]lib[/\\]metadata\.ts$/},()=>({contents:'export const PREVIEW_ORIGIN="https://stupid.gifts";',loader:'ts'}));
}};
function publicDefines(analytics){
  if(analytics&&(!/^phc_[a-zA-Z0-9]+$/.test(analytics.posthogKey??'')||analytics.posthogHost!=='https://us.i.posthog.com'))throw Error('runtime_app_analytics_invalid');
  return{'process.env.NODE_ENV':'"production"','process.env.CATALOG_SITE_MODE':'"stupid-production"',
    'process.env.NEXT_PUBLIC_STATIC_SITE_MODE':'"stupid-production"','process.env.NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED':JSON.stringify(analytics?'true':'false'),
    'process.env.NEXT_PUBLIC_POSTHOG_KEY':JSON.stringify(analytics?.posthogKey??''),'process.env.NEXT_PUBLIC_POSTHOG_HOST':JSON.stringify(analytics?.posthogHost??'')};
}
/** Data-independent application build. Inputs are code and explicit public
 * analytics configuration only; never read a catalog, D1, R2, env file or API. */
export async function buildRuntimeApp({root=ROOT,outdir=path.join(root,'build/runtime-app'),codeSha,releaseId,publicAnalytics}={}){
  root=await fs.realpath(root);outdir=path.resolve(outdir);
  if(!/^[a-f0-9]{40}$/.test(codeSha??'')||!/^[a-zA-Z0-9._-]{1,200}$/.test(releaseId??''))throw Error('runtime_app_identity_invalid');
  const existing=await fs.readdir(outdir).catch(error=>{if(error.code==='ENOENT')return[];throw error;});
  if(existing.length)throw Error('runtime_app_output_exists');
  const started=Date.now(),assetsDirectory=path.join(outdir,'assets');await fs.mkdir(path.join(assetsDirectory,'app'),{recursive:true});
  const analytics=publicAnalytics?.enabled?publicAnalytics:undefined;
  const common={absWorkingDir:root,bundle:true,format:'esm',platform:'browser',target:'es2022',jsx:'automatic',minify:true,
    sourcemap:false,metafile:true,treeShaking:true,tsconfig:path.join(root,'tsconfig.json'),plugins:[presentationPlugin],logLevel:'silent'};
  const client=await build({...common,entryPoints:[path.join(root,'static-site/runtime/client.tsx')],write:false,define:publicDefines(analytics)});
  if(Object.keys(client.metafile.inputs).some(name=>/content\/(?:catalog|homepage)|fixtures\/catalog/.test(name)))throw Error('runtime_app_catalog_compiled');
  const clientBytes=client.outputFiles[0].contents,clientPath='/app/client-'+hash(clientBytes).slice(0,20)+'.js';
  await fs.writeFile(path.join(assetsDirectory,clientPath),clientBytes);
  const css=await postcss([tailwind({content:[path.join(root,'static-site/components/**/*.{ts,tsx}'),path.join(root,'static-site/runtime/**/*.{ts,tsx}'),path.join(root,'components/ProductImage.tsx')],theme:{extend:{}},plugins:[]}),autoprefixer()])
    .process(await fs.readFile(path.join(root,'static-site/app/styles.css'),'utf8'),{from:path.join(root,'static-site/app/styles.css'),map:false});
  const cssPath='/app/site-'+hash(css.css).slice(0,20)+'.css';await fs.writeFile(path.join(assetsDirectory,cssPath),css.css);
  const {renderOgPng}=await import('../../static-site/lib/og-image.ts');
  const brand=await renderOgPng({schemaVersion:1,styleVersion:1,identity:{name:'Stupid Gifts',origin:'https://stupid.gifts',tagline:'Very bad ideas. Carefully considered.'},
    kind:'brand',subjectId:'brand',title:'Very bad ideas. Carefully considered.',eligibleUntil:null});
  const brandOgPath='/app/brand-'+hash(brand).slice(0,20)+'.png';await fs.writeFile(path.join(assetsDirectory,brandOgPath),brand);
  const owned=['fonts/inter-latin.woff2','fonts/OFL.txt','images/gift-placeholder.svg','favicon.ico'];
  for(const name of owned){await fs.mkdir(path.dirname(path.join(assetsDirectory,name)),{recursive:true});await fs.copyFile(path.join(root,'static-site/public',name),path.join(assetsDirectory,name));}
  const checksums={};for(const name of [clientPath.slice(1),cssPath.slice(1),brandOgPath.slice(1),...owned])checksums['/'+name]=hash(await fs.readFile(path.join(assetsDirectory,name)));
  const metadata={schemaVersion:1,kind:'runtime-app',codeSha,releaseId,clientPath,cssPath,brandOgPath,checksums},metadataBytes=Buffer.from(JSON.stringify(metadata)+'\n'),manifestSha256=hash(metadataBytes);
  await fs.writeFile(path.join(outdir,'app-manifest.json'),metadataBytes);
  const options={codeSha,releaseId,manifestSha256,clientPath,cssPath,brandOgPath,analytics:Boolean(analytics)};
  const entryPath=path.join(outdir,'worker.mjs');
  const worker=await build({...common,stdin:{contents:`import {createRuntimeSite} from ${JSON.stringify(path.join(root,'workers/site/runtime-site.tsx'))};
import {runtimeAdminRequest} from ${JSON.stringify(path.join(root,'workers/site/runtime-admin.ts'))};
const options=${JSON.stringify(options)};
export default createRuntimeSite({...options,handleRequest:(request,env,view)=>runtimeAdminRequest(request,env,view,{release_id:options.releaseId,code_sha:options.codeSha,
manifest_sha256:options.manifestSha256,catalog_revision:view.head.catalogRevision,catalog_snapshot_sha256:view.head.snapshotSha256})});`,resolveDir:root,loader:'ts'},
    outfile:entryPath,define:publicDefines(undefined)});
  const inputs=Object.keys(worker.metafile.inputs);
  if(inputs.some(name=>/content\/(?:catalog|homepage)|fixtures\/catalog/.test(name)))throw Error('runtime_app_catalog_compiled');
  if((await fs.readFile(entryPath,'utf8')).includes('node:crypto'))throw Error('runtime_app_node_dependency');
  return{entryPath,assetsDirectory,metadata,manifestSha256,metrics:{elapsedMs:Date.now()-started,assetFiles:Object.keys(checksums).length,
    assetBytes:(await Promise.all(Object.keys(checksums).map(name=>fs.stat(path.join(assetsDirectory,name))))).reduce((n,s)=>n+s.size,0),workerBytes:(await fs.stat(entryPath)).size}};
}
async function main(){
  const [outdir,releaseId]=process.argv.slice(2);if(!outdir||!releaseId||process.argv.length!==4)throw Error('runtime_app_arguments');
  const git=(...args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8'}).trim();
  if(process.versions.node.split('.')[0]!=='22'||git('status','--porcelain','--untracked-files=all'))throw Error('runtime_app_source_not_clean');
  console.log(JSON.stringify(await buildRuntimeApp({outdir,releaseId,codeSha:git('rev-parse','HEAD')})));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
