import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export const CONTENT_ADMIN_KEYCHAIN_SERVICE='goose.gifts.CONTENT_ADMIN_ACCESS';
const origin='https://stupid.gifts',prefix='/api/content-admin';
const run=promisify(execFile);

/** Never follow a login redirect with credentials attached. Only the production
 * staff routes receive the token; use the same revision/CSRF checks as before. */
export async function contentAdminFetch(resource,init={}){
  const pathname=resource.split('?')[0];
  if(!/^\/[a-zA-Z0-9._/-]{1,300}$/.test(pathname)||pathname.includes('//')||pathname.split('/').some(part=>part==='.'||part==='..'))
    throw Error('content_admin_route_invalid');
  const url=new URL(prefix+resource,origin),method=(init.method??'GET').toUpperCase();
  if(url.origin!==origin||url.pathname!==prefix+pathname||url.hash||!['GET','POST','PUT'].includes(method))throw Error('content_admin_route_invalid');
  let credential;
  try{
    const {stdout}=await run('/usr/bin/security',['find-generic-password','-s',CONTENT_ADMIN_KEYCHAIN_SERVICE,'-a','goose.gifts','-w'],
      {encoding:'utf8',timeout:4000,maxBuffer:2048});
    credential=JSON.parse(stdout);
    if(!/^[a-f0-9]{32}\.access$/.test(credential?.clientId)||!/^[-\w]{32,256}$/.test(credential?.clientSecret))throw Error();
  }catch{throw Error('content_admin_keychain_unavailable');}
  const headers=new Headers(init.headers);
  headers.delete('Host');
  headers.set('CF-Access-Client-Id',credential.clientId);
  headers.set('CF-Access-Client-Secret',credential.clientSecret);
  if(method!=='GET')headers.set('Origin',origin);
  return fetch(url,{...init,method,headers,redirect:'manual',signal:init.signal??AbortSignal.timeout(20000)});
}
