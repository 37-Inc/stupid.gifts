/** Both UTC offsets are scheduled; Pacific time selects the real slot across
 * daylight saving. Catch-ups carry the ORIGINAL due time, not a new batch. */
export function catalogClockSlot(time){
  const at=new Date(time);
  if(!Number.isFinite(at.getTime()))return null;
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',hourCycle:'h23'}).format(at));
  if(![8,10,20,22].includes(hour))return null;
  // Cloudflare can provide the actual wake time, including seconds or delay.
  // Route by the Pacific slot hour, then give every wake the same due identity.
  at.setUTCMinutes(30,0,0);
  return{mode:hour<12?'full':'photos',scheduled_at:new Date(at.getTime()-([10,22].includes(hour)?7200000:0)).toISOString()};
}

export function catalogScheduledTime(mode,value){
  if(!value)return null;
  const slot=catalogClockSlot(value);
  if(!slot||slot.mode!==mode||slot.scheduled_at!==value)throw Error('catalog_hosted_schedule_invalid');
  return new Date(value);
}
