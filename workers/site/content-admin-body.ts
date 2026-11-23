import {ContentAdminError} from '../../lib/catalog/content-admin.ts';

export async function boundedAdminBody(request:Request,limit:number){
  const tooLarge=()=>new ContentAdminError(413,'request_too_large');
  if(Number(request.headers.get('Content-Length'))>limit)throw tooLarge();
  const reader=request.body?.getReader();
  if(!reader)throw new ContentAdminError(400,'invalid_request');
  let size=0;const chunks:Uint8Array[]=[];
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;
    if(size>limit){await reader.cancel();throw tooLarge();}chunks.push(next.value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;
  for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  return bytes;
}
