import {createRemoteJWKSet,jwtVerify} from 'jose';
import type {JWTVerifyGetKey} from 'jose';

export interface ContentAdminAuthEnv {
  CONTENT_ADMIN_ENABLED?:string;CONTENT_ADMIN_TEAM_DOMAIN?:string;CONTENT_ADMIN_AUD?:string;CONTENT_ADMIN_STAFF_EMAILS?:string;
}
let cached:{issuer:string;keys:JWTVerifyGetKey}|undefined;
/** Access headers are untrusted until signature/issuer/audience/time validation.
 * Static Assets do not forward ctx.access, so use the documented JWT path. */
export async function contentAdminActor(request:Request,env:ContentAdminAuthEnv,now:number,keys?:JWTVerifyGetKey){
  const issuer=env.CONTENT_ADMIN_TEAM_DOMAIN,audience=env.CONTENT_ADMIN_AUD;
  if(env.CONTENT_ADMIN_ENABLED!=='true'||!issuer||!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)
    ||!audience||!/^[a-f0-9]{64}$/.test(audience)||!env.CONTENT_ADMIN_STAFF_EMAILS)return null;
  const token=request.headers.get('Cf-Access-Jwt-Assertion');if(!token||token.length>16000)return null;
  try{
    if(!keys){
      if(cached?.issuer!==issuer)cached={issuer,keys:createRemoteJWKSet(new URL(issuer+'/cdn-cgi/access/certs'),{timeoutDuration:5000})};
      keys=cached!.keys;
    }
    const {payload}=await jwtVerify(token,keys,{issuer,audience,algorithms:['RS256'],currentDate:new Date(now),
      requiredClaims:['exp','iat','iss','sub','aud']});
    const staff=env.CONTENT_ADMIN_STAFF_EMAILS.split(',').map(value=>value.trim().toLowerCase()).filter(Boolean);
    if(payload.type!=='app'||typeof payload.sub!=='string'||!payload.sub||payload.sub.length>256
      ||typeof payload.email!=='string'||!staff.includes(payload.email.toLowerCase()))return null;
    return payload.sub;
  }catch{return null;}
}
