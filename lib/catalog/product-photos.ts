export const PRODUCT_MEDIA_BUCKET='stupid-gifts-product-media';
export const PRODUCT_PHOTO_ROOT='/images/product-media/';
export const PRODUCT_PHOTO_MAX=2*1024*1024;
export const PHOTO_PRODUCT_ID=/^[a-zA-Z0-9_-]{1,100}$/;
export const PHOTO_TYPES={jpg:'image/jpeg',png:'image/png',webp:'image/webp'} as const;
export type ProductPhoto={sha256:string;format:keyof typeof PHOTO_TYPES;bytes:number};

export function readProductPhoto(value:unknown):ProductPhoto|null{
  if(!value||typeof value!=='object'||Object.keys(value).length!==3)return null;
  const {sha256,format,bytes}=value as Partial<ProductPhoto>;
  return typeof sha256==='string'&&/^[a-f0-9]{64}$/.test(sha256)&&typeof format==='string'&&Object.hasOwn(PHOTO_TYPES,format)
    &&typeof bytes==='number'&&Number.isSafeInteger(bytes)&&bytes>0&&bytes<=PRODUCT_PHOTO_MAX?{sha256,format,bytes}:null;
}
export const productPhotoKey=(id:string,photo:ProductPhoto)=>id+'/'+photo.sha256+'.'+photo.format;
export const productPhotoPath=(id:string,photo:ProductPhoto)=>PRODUCT_PHOTO_ROOT+productPhotoKey(id,photo);

export function productPhotoFormat(bytes:Uint8Array):ProductPhoto['format']|null{
  const matches=(at:number,...signature:number[])=>signature.every((value,i)=>bytes[at+i]===value);
  if(bytes.length>=16&&matches(0,255,216,255)&&matches(bytes.length-2,255,217))return 'jpg';
  if(matches(0,137,80,78,71,13,10,26,10)&&matches(12,73,72,68,82)&&matches(bytes.length-12,0,0,0,0,73,69,78,68))return 'png';
  if(bytes.length>=20&&matches(0,82,73,70,70)&&matches(8,87,69,66,80)&&matches(12,86,80,56)
    &&new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(4,true)===bytes.length-8)return 'webp';
  return null;
}
