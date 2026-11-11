/** Both UTC offsets are scheduled; Pacific time selects the real slot across
 * daylight saving. Catch-ups carry the ORIGINAL due time, not a new batch. */
export function catalogClockSlot(time){
  const at=new Date(time);
  if(!Number.isFinite(at.getTime())||at.getUTCMinutes()!==30||at.getUTCSeconds()!==0||at.getUTCMilliseconds()!==0)return null;
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',hourCycle:'h23'}).format(at));
  if(![8,10,20,22].includes(hour))return null;
  return{mode:hour<12?'full':'photos',scheduled_at:new Date(at.getTime()-([10,22].includes(hour)?7200000:0)).toISOString()};
}

export function catalogScheduledTime(mode,value){
  if(!value)return null;
  const slot=catalogClockSlot(value);
  if(!slot||slot.mode!==mode||slot.scheduled_at!==value)throw Error('catalog_hosted_schedule_invalid');
  return new Date(value);
}
