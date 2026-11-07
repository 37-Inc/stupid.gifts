import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runs INSIDE the isolated Linux network namespace. There is one fixed Unix
// destination, owned by the outer accounted bridge; no arbitrary TCP forwarding.
export function uploadRelay(socketPath){
  const outgoing=new Set();let closed=false;
  const server=createServer({maxHeaderSize:16*1024},(req,res)=>{
    const remote=request({socketPath,path:req.url,method:req.method,headers:req.headers,agent:false},reply=>{
      reply.once('error',()=>res.destroy());res.writeHead(reply.statusCode??502,reply.headers);reply.pipe(res);
    });
    outgoing.add(remote);remote.once('close',()=>outgoing.delete(remote));
    remote.once('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    req.once('error',()=>remote.destroy());req.once('aborted',()=>remote.destroy());
    res.once('close',()=>{if(!res.writableEnded)remote.destroy();});req.pipe(remote);
  });
  server.on('connect',(_req,socket)=>socket.destroy());
  server.on('clientError',(_error,socket)=>socket.destroy());
  return{server,close(){if(closed)return;closed=true;for(const remote of outgoing)remote.destroy();server.closeAllConnections();server.close();}};
}

export async function runUploadRelay(socketPath,prefix,file,args,{port=0}={}){
  if(!socketPath?.startsWith('/')||!/^\/[a-f0-9]{48}\/client\/v4$/.test(prefix)||!file?.startsWith('/'))
    throw Error('publication_upload_relay_invalid');
  const relay=uploadRelay(socketPath);
  await new Promise((resolve,reject)=>{relay.server.once('error',reject);relay.server.listen(port,'127.0.0.1',resolve);});
  const address=relay.server.address();
  if(!address||typeof address==='string')throw Error('publication_upload_relay_invalid');
  const child=spawn(file,args,{stdio:'inherit',env:{...process.env,CLOUDFLARE_API_BASE_URL:`http://127.0.0.1:${address.port}${prefix}`}});
  const stop=()=>{child.kill('SIGTERM');relay.close();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{process.exitCode=await new Promise(resolve=>{child.once('error',()=>resolve(1));child.once('exit',code=>resolve(code??1));});}
  finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);relay.close();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const [socketPath,prefix,file,...args]=process.argv.slice(2);await runUploadRelay(socketPath,prefix,file,args);
}
