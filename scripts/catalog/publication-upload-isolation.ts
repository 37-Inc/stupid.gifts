import { constants } from 'node:fs';
import { access, lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PublicationCommand } from './publish-release.ts';

export interface UploadEndpoint { prefix:string;port?:number;socketPath?:string }
export interface UploadIsolation {
  transport:'tcp'|'unix';
  available():Promise<void>;
  wrap(command:PublicationCommand,endpoint:UploadEndpoint):Promise<PublicationCommand>;
}
const SEATBELT='/usr/bin/sandbox-exec',BWRAP='/usr/bin/bwrap';
const relay=fileURLToPath(new URL('./publication-upload-relay.mjs',import.meta.url));
const unavailable=()=>new Error('publication_upload_sandbox_unavailable');
const absolute=(value:unknown):value is string=>typeof value==='string'&&path.isAbsolute(value)
  &&path.normalize(value)===value&&!value.includes('\0');

/** Bubblewrap constructs a policy; it is not a security policy on its own.
 * https://github.com/containers/bubblewrap/blob/main/bwrap.xml
 * Kept separate so bridge/ledger unit tests can inject a fixture launcher on
 * any OS. Production callers use the native launcher, never a plain fallback. */
export function publicationUploadIsolation(platform:NodeJS.Platform=process.platform):UploadIsolation {
  if(platform==='darwin')return{
    transport:'tcp',available:()=>access(SEATBELT,constants.X_OK),
    async wrap(command,{port,prefix}){
      if(!Number.isInteger(port)||!port||!prefix.startsWith('/'))throw unavailable();
      const profile=`(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote tcp4 "localhost:${port}"))`;
      return{...command,file:SEATBELT,args:['-p',profile,command.file,...command.args],env:{...command.env,
        CLOUDFLARE_API_BASE_URL:`http://127.0.0.1:${port}${prefix}`}};
    },
  };
  if(platform==='linux')return{transport:'unix',available:()=>access(BWRAP,constants.X_OK),wrap:linuxCommand};
  throw unavailable();
}

async function privateDirectory(value:string){
  if(!absolute(value))throw unavailable();
  await mkdir(value,{recursive:true,mode:0o700});
  const stat=await lstat(value);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o777)!==0o700
    ||await realpath(value)!==value)throw unavailable();
}
async function linuxCommand(command:PublicationCommand,{socketPath,prefix}:UploadEndpoint):Promise<PublicationCommand>{
  if(!absolute(command.file)||!absolute(command.cwd)||['/','/tmp','/run','/var','/usr','/etc'].includes(command.cwd)
    ||!absolute(socketPath)||!/^\/[a-f0-9]{48}\/client\/v4$/.test(prefix))throw unavailable();
  const flag=(name:string)=>{
    const at=command.args.indexOf(name);
    if(at<0||command.args.lastIndexOf(name)!==at||!absolute(command.args[at+1]))throw unavailable();
    return command.args[at+1];
  };
  const config=flag('--config'),out=flag('--outdir'),tmp=command.env.TMPDIR;
  const log=command.env.WRANGLER_LOG_PATH,output=command.env.WRANGLER_OUTPUT_FILE_PATH;
  if(!absolute(tmp)||!absolute(log)||!absolute(output))throw unavailable();
  const runtime=path.dirname(tmp),inside=(child:string,parent:string)=>child.startsWith(parent+path.sep);
  if(runtime==='/'||![log,out,output].every(value=>inside(value,runtime)))throw unavailable();
  for(const writable of [tmp,log,out])if(writable===command.env.HOME
    ||[command.cwd,path.dirname(config)].some(source=>source===writable||inside(source,writable)))throw unavailable();
  await privateDirectory(runtime);
  for(const directory of [tmp,log,out,path.join(tmp,'home')])await privateDirectory(directory);
  const fd=await open(output,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  try{const stat=await fd.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.nlink!==1||(stat.mode&0o777)!==0o600)throw unavailable();}
  finally{await fd.close();}
  const args=['--unshare-user','--unshare-net','--unshare-pid','--unshare-ipc','--disable-userns',
    '--cap-drop','ALL','--new-session','--die-with-parent','--proc','/proc','--dev','/dev','--tmpfs','/tmp'];
  const mounted=new Set<string>();
  const bind=async(source:string,writable=false,optional=false)=>{
    if(mounted.has(source))return;
    try{await lstat(source);}catch(error){if(optional&&(error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    args.push(writable?'--bind':'--ro-bind',source,source);mounted.add(source);
  };
  // Never bind the host root, /run, Docker sockets or the caller's HOME. Fresh
  // /proc hides host namespace descriptors; nested user namespaces are disabled.
  for(const directory of ['/usr','/bin','/lib','/lib64'])await bind(directory,false,true);
  const node=await realpath(command.file);
  for(const source of [command.cwd,node,path.dirname(config),relay])await bind(source);
  // Local development may use a shared dependency symlink. Hosted npm ci uses
  // an ordinary directory; neither case needs the surrounding private/home tree.
  try{await bind(await realpath(path.join(command.cwd,'node_modules')));}catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
  await bind(socketPath);
  for(const directory of [tmp,log,out])await bind(directory,true);
  await bind(output,true);
  args.push('--chdir',command.cwd,'--',node,relay,socketPath,prefix,node,...command.args);
  return{...command,file:BWRAP,args,env:{...command.env,HOME:path.join(tmp,'home')}};
}
