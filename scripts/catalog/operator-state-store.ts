import {constants} from 'node:fs';
import {lstat,mkdir,open,readFile,realpath,rename} from 'node:fs/promises';
import path from 'node:path';
import type {CatalogObjectStore} from './r2-object-store.ts';

const fail=(reason:string):never=>{throw Error('catalog_operator_state_'+reason);};
const LIMIT=10*1024*1024;

/** Small protected-file adapter for existing operator metadata. Run phases and
 * reservations remain in RunWorkspace. Only the existing accepted/pending
 * pointers are mutable; no lock files or credentials enter the object store. */
export function createOperatorStateStore(base:string,remote?:CatalogObjectStore){
  if(!path.isAbsolute(base)||path.normalize(base)!==base||base==='/')fail('base');
  function key(file:string){
    const relative=path.relative(base,file);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)
      ||relative.split(path.sep).some(part=>!part||part==='locks'||! /^[a-zA-Z0-9._-]+$/.test(part)))fail('path');
    return 'operator/'+relative.split(path.sep).join('/');
  }
  async function local(file:string){
    key(file);const stat=await lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||stat.nlink!==1
      ||(stat.mode&0o777)!==0o600||stat.size>LIMIT||await realpath(file)!==file)fail('file');
    return readFile(file);
  }
  async function save(file:string,bytes:Uint8Array){
    key(file);if(bytes.byteLength>LIMIT)fail('size');
    await mkdir(path.dirname(file),{recursive:true,mode:0o700});
    const parent=await lstat(path.dirname(file));
    if(parent.uid!==process.getuid?.()||(parent.mode&0o777)!==0o700||await realpath(path.dirname(file))!==path.dirname(file))fail('directory');
    let handle;
    try{handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      if(!(await local(file)).equals(Buffer.from(bytes)))fail('immutable_changed');return;}
    try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  }
  async function bytes(file:string){
    const objectKey=key(file);let actual:Buffer|undefined;
    try{actual=await local(file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(actual)return actual;
    const object=await remote?.get(objectKey);
    if(!object){const missing=new Error('catalog_operator_state_missing') as NodeJS.ErrnoException;missing.code='ENOENT';throw missing;}
    await save(file,object.bytes);return Buffer.from(object.bytes);
  }
  return{
    bytes,
    async put(file:string,value:unknown){
      const body=Buffer.from(JSON.stringify(value)+'\n');
      // Durable metadata is acknowledged before a provider phase can be started.
      if(remote)await remote.putImmutable(key(file),body);
      await save(file,body);return body;
    },
    async pointer(name:'last-success'|'pending-run'|'cleanup-runs'|'title-repairs',file:string,value:unknown,expected:Uint8Array|null){
      key(file);const body=Buffer.from(JSON.stringify(value)+'\n');
      if(body.length>LIMIT)fail('size');
      if(remote){const objectKey=`pointers/${name}.json`,current=await remote.get(objectKey);
        if(current&&Buffer.from(current.bytes).equals(body)){/* exact lost-ACK recovery */}
        else{
          if(Boolean(current)!==Boolean(expected)||current&&expected&&!Buffer.from(current.bytes).equals(Buffer.from(expected)))fail('pointer_conflict');
          await remote.compareAndSwap(objectKey,current?.etag??null,body);
        }
      }else{
        let current:Buffer|null=null;try{current=await local(file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(!current?.equals(body)&&(Boolean(current)!==Boolean(expected)||current&&expected&&!current.equals(Buffer.from(expected))))fail('pointer_conflict');
      }
      const temporary=file+'.'+process.pid+'.next';await save(temporary,body);await rename(temporary,file);
      return body;
    },
    async readPointer(name:'last-success'|'pending-run'|'cleanup-runs'|'title-repairs',file:string){
      if(!remote)return bytes(file);
      const object=await remote.get(`pointers/${name}.json`);
      if(!object){const missing=new Error('catalog_operator_state_missing') as NodeJS.ErrnoException;missing.code='ENOENT';throw missing;}
      const temporary=file+'.'+process.pid+'.next';await save(temporary,object.bytes);await rename(temporary,file);
      return Buffer.from(object.bytes);
    },
  };
}
