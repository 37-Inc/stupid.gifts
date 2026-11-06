export type GagAppeal = 'standout' | 'giftable' | 'ordinary' | 'unreviewed';
/** Public ranking signals, never campaign rates, terms, account IDs or tokens. */
export interface MerchandisingSignal {
  sourceTitle?: string;
  sourceDescription?: string;
  appeal?: GagAppeal;
  variantGroup?: string;
  commissionPriority?: number;
  commissionUntil?: string;
}
export type Merchandising = Readonly<Record<string, MerchandisingSignal>>;
export function readMerchandising(value: unknown): Merchandising | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 10000) return null;
  for (const [id,raw] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item=raw as MerchandisingSignal;
    if(Object.keys(item).some(key=>!['sourceTitle','sourceDescription','appeal','variantGroup','commissionPriority','commissionUntil'].includes(key))
      ||(item.sourceTitle===undefined)!==(item.sourceDescription===undefined)
      ||item.sourceTitle!==undefined&&(typeof item.sourceTitle!=='string'||typeof item.sourceDescription!=='string')
      || item.appeal!==undefined&&!['standout','giftable','ordinary','unreviewed'].includes(item.appeal)
      || item.variantGroup!==undefined&&!/^[a-zA-Z0-9._-]{1,100}$/.test(item.variantGroup)
      || item.commissionPriority!==undefined&&(!Number.isInteger(item.commissionPriority)||item.commissionPriority<1||item.commissionPriority>10000)
      || (item.commissionPriority===undefined)!==(item.commissionUntil===undefined)
      || item.commissionUntil!==undefined&&(!Number.isFinite(Date.parse(item.commissionUntil))
        ||new Date(item.commissionUntil).toISOString()!==item.commissionUntil))return null;
  }
  return structuredClone(value) as Merchandising;
}
export function merchandisingForProduct(product:{id:string;title:string;description:string},input:Merchandising):MerchandisingSignal|undefined {
  const signal=input[product.id];
  return signal&&(!signal.sourceTitle||signal.sourceTitle===product.title&&signal.sourceDescription===product.description)?signal:undefined;
}
export const appealPriority=(appeal: GagAppeal | undefined)=>appeal==='standout'?2:appeal==='ordinary'?0:1;
export const usableCommissionPriority=(signal:MerchandisingSignal|undefined,now:number)=>
  signal?.commissionUntil&&Date.parse(signal.commissionUntil)>now?signal.commissionPriority??0:0;
