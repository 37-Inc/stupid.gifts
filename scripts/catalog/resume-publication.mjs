// Finish an acknowledged permanent upload; never fetch, build, or upload again.
import fs from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {sha256} from './migration.ts';
import {openRunWorkspace} from './run-workspace.ts';
import {runCloudflareWeekly,validateCloudflareWeeklyConfig,weeklyCommandSummary} from './run-cloudflare-weekly.ts';
import {resolveWranglerOAuth} from './check-cloudflare-runner.ts';
import {headroom,currentD1Plan} from './daily-operator.mjs';

const base=path.join(homedir(),'.codex/private/goose-gifts-migration');
const care=base+'/daily-catalog-care',workspace=base+'/weekly-runs';
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
function requireThat(ok,code){if(!ok)throw Error('resume_publication_'+code);}
async function read(file,hash){
  requireThat(file.startsWith(base+'/')&&await fs.realpath(file)===file,'path');
  const stat=await fs.lstat(file);requireThat(stat.isFile()&&stat.uid===process.getuid()&&(stat.mode&0o777)===0o600&&stat.nlink===1&&stat.size<10*1024*1024,'file');
  const bytes=await fs.readFile(file);requireThat(!hash||sha256(bytes)===hash,'digest');return JSON.parse(bytes);
}
async function put(file,value){
  const bytes=JSON.stringify(value)+'\n';
  try{await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});}
  catch(e){if(e.code!=='EEXIST'||await fs.readFile(file,'utf8')!==bytes)throw e;}
  return sha256(bytes);
}
export function validateResumeCheckpoint(cp){
  const p=cp?.checkpoint.control?.publication;
  requireThat(p&&p.stage==='activating'&&!p.permit&&!p.deploymentId&&p.versionReference&&p.intent?.nextExpiry===null
    &&cp.checkpoint.owner?.phase==='freezing'&&cp.checkpoint.pins.publicationUploadAcknowledged
    &&!cp.checkpoint.pins.publicationUploadReview,'acknowledged_permanent_upload_required');
  return p;
}
export async function resumePublication(day){
  requireThat(/^\d{4}-\d{2}-\d{2}$/.test(day),'day');
  requireThat(process.versions.node.startsWith('22.')&&!Object.keys(process.env).some(k=>/^(AMAZON_|OPENAI_|POSTGRES_|VERCEL_|CATALOG_|CLOUDFLARE_API_TOKEN)/.test(k)),'environment');
  const directory=care+'/'+day,record=await read(directory+'/operator.json'),config=validateCloudflareWeeklyConfig(await read(record.configPath,record.configSha256));
  const root=config.publication.sourceRoot;
  requireThat(record.source===config.codeSha&&git(root,'rev-parse','HEAD')===config.codeSha&&!git(root,'status','--porcelain')
    &&sha256(await fs.readFile(root+'/scripts/catalog/daily-operator.mjs'))===record.helperSha256,'original_source');
  const options={directory:workspace,repository:root,mode:'resume',runId:config.runId,codeSha:config.codeSha,configSha256:record.configSha256,
    scope:{environment:config.environment,accountId:config.accountId,databaseId:config.database.id,databaseName:config.database.name,
      workerName:config.publication.workerName,indexName:config.vectorIndex.name},retention:config.retention,
    budgetCaps:{httpRequests:config.limits.requests,sqlStatements:config.limits.statements}};
  let authority;
  try{authority=await read(directory+'/resume-authority.json');}catch(e){if(e.code!=='ENOENT')throw e;}
  const w=await openRunWorkspace(options);
  try{
    const cp=await w.readCheckpoint({controlOnly:true});
    if(!authority){
      const p=validateResumeCheckpoint(cp),reviewedAt=new Date().toISOString();
      authority={schemaVersion:1,runId:config.runId,checkpointSha256:cp.sha256,versionReference:p.versionReference,
        reviewedAt,activationDeadline:new Date(Date.parse(reviewedAt)+2*3600000).toISOString(),configSha256:record.configSha256};
      await put(directory+'/resume-authority.json',authority);
    }
    requireThat(authority.runId===config.runId&&authority.configSha256===record.configSha256,'authority');
  }finally{await w.close();}
  const authoritySha=sha256(await fs.readFile(directory+'/resume-authority.json'));
  const finish={budget:{expectedCheckpointSha256:authority.checkpointSha256,approvalReference:authoritySha,
    versionReference:authority.versionReference,allowance:{httpRequests:1000,sqlStatements:2000},reportedRowsRead:3000000},
    authorization:{authorizationSha256:authoritySha,versionReference:authority.versionReference,
      reviewedAt:authority.reviewedAt,activationDeadline:authority.activationDeadline}};
  const token=await resolveWranglerOAuth(),plan=await currentD1Plan(token);
  // No higher service tier is purchased. The original immutable charges remain;
  // this lane checks current account usage separately from historical run costs.
  await headroom(token,undefined,null,fetch,plan);
  const result=await runCloudflareWeekly({command:'resume',configPath:record.configPath,configSha256:record.configSha256,
    workspace,cadenceOnly:true},{repository:root,finishRecovery:finish,
    publication:{command:async()=>{throw Error('resume_publication_upload_forbidden');}}});
  if(result.state==='finalized'&&result.catalogSeal){
    const w=await openRunWorkspace(options);
    try{
      const cp=await w.readCheckpoint({controlOnly:true}),p=cp?.checkpoint.control?.publication;
      requireThat(cp?.checkpoint.phase==='finalized'&&cp.checkpoint.owner===null&&p?.stage==='published','not_finalized');
      const file=directory+'/catalog-control.json',hash=await put(file,result.catalogSeal),next={control:{path:file,sha256:hash},
        versionReference:p.versionReference,manifestSha256:p.intent.manifestSha256};
      const old=await read(care+'/last-success.json');
      requireThat([config.inputs.previous.sha256,hash].includes(old.control.sha256),'successor_changed');
      await put(directory+'/success.json',{next,result:weeklyCommandSummary(result),source:config.codeSha});
      if(old.control.sha256!==hash){await put(directory+'/next-success.json',next);await fs.rename(directory+'/next-success.json',care+'/last-success.json');}
    }finally{await w.close();}
  }
  console.log(JSON.stringify(weeklyCommandSummary(result)));return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  if(process.argv.length!==3)throw Error('Usage: node --import tsx scripts/catalog/resume-publication.mjs YYYY-MM-DD');
  const result=await resumePublication(process.argv[2]);if(result.state!=='finalized')process.exitCode=2;
}
