import {aliases,containsName,decide,norm,RULE_VERSION,SOURCE_DEFINITIONS} from './intake-rules.js';
const all=async(db,q,a=[]) => (await db.prepare(q).bind(...a).all()).results;
const one=(db,q,a=[])=>db.prepare(q).bind(...a).first();
const now=()=>new Date().toISOString();
const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status,publicMessage:message});};
const field=(s,max=200)=>{if(typeof s!=='string'||s.trim().length>max)fail(400,'人物信息格式无效');return s.trim();};
const text=s=>String(s||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const https=s=>{try{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}};
export async function trackPerson(db,input){
 const name=field(input.name||'',100),hint=field(input.identity_hint||'',200),alias=field(input.alias||'',200);if(name.length<2)fail(400,'请输入至少两个字符的人物姓名');
 const known=(await all(db,'SELECT * FROM people')).map(p=>({...JSON.parse(p.data),id:p.id}));
 const matches=known.filter(p=>aliases(p).some(n=>norm(n)===norm(name)));
 // Existing identities are reused only when there is exactly one match; new identities remain unverified.
 const p=matches.length===1?matches[0]:{id:'person-'+(await hash(norm(name)+'|'+norm(hint))).slice(0,24),name,alias,identity_hint:hint,identity_terms:hint.split(/[,，;；]/).filter(Boolean),identity_verified:false};
 const current=await one(db,'SELECT * FROM tracking_people WHERE id=?',[p.id]);
 if(current)return {...JSON.parse(current.data),id:current.id};
 if((await one(db,'SELECT COUNT(*) n FROM tracking_people')).n>=200)fail(429,'人物追踪已达200人上限');
 await db.prepare('INSERT OR IGNORE INTO tracking_people(id,data,enabled,created_at,next_run_at) VALUES(?,?,1,?,0)').bind(p.id,JSON.stringify(p),now()).run();return p;
}
export async function startPerson(db,id){
 const row=await one(db,'SELECT * FROM tracking_people WHERE id=?',[id]);if(!row)fail(404,'追踪人物不存在');if(!row.enabled)fail(409,'该人物已暂停追踪');
 const p=JSON.parse(row.data),names=[...new Set(aliases(p).map(n=>n.trim()))].slice(0,2),queries=names.flatMap(term=>['us','cn'].map(country=>({term,country,status:'pending',count:0,cached:false})));
 const data={queries,position:0,matched:0,changed:0,skipped:0,sources:0,model_calls:0};
 await db.prepare("INSERT INTO tracking_jobs(person_id,run_id,status,data,created_at,updated_at) VALUES(?,?,'pending',?,?,?) ON CONFLICT(person_id) DO UPDATE SET run_id=excluded.run_id,status='pending',data=excluded.data,created_at=excluded.created_at,updated_at=excluded.updated_at WHERE tracking_jobs.status IN ('completed','partial','failed','cancelled')").bind(id,crypto.randomUUID(),JSON.stringify(data),now(),now()).run();return job(await one(db,'SELECT * FROM tracking_jobs WHERE person_id=?',[id]));
}
function job(j){return j?{...j,data:JSON.parse(j.data)}:null;}
export async function searchEpisodes(db,term,country,fetcher=fetch){
 const key=await hash('apple-v1|'+norm(term)+'|'+country),cached=await one(db,'SELECT * FROM discovery_cache WHERE key=? AND expires>?',[key,Date.now()]);if(cached)return {items:JSON.parse(cached.data),cached:true,fetched_at:cached.fetched_at};
 // Shared global budget: API requests are limited even if several people are updated together.
 const bucket='apple-minute:'+Math.floor(Date.now()/60000);
 const budget=await one(db,'INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<12 RETURNING count',[bucket,Date.now()+120000]);if(!budget)fail(429,'目录请求达到每分钟12次上限，请稍后继续');
 const u=new URL('https://itunes.apple.com/search');u.search=new URLSearchParams({term,media:'podcast',entity:'podcastEpisode',country,limit:'50'}).toString();
 const response=await fetcher(u.href,{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Accept:'application/json'}});if(!response.ok)fail(502,'Apple Podcasts 搜索返回 HTTP '+response.status);
 const reader=response.body?.getReader();if(!reader)fail(502,'目录返回空响应');let size=0,parts=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>3*1024*1024)fail(502,'目录响应超过大小限制');parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}let payload;try{payload=JSON.parse(new TextDecoder().decode(bytes));}catch{fail(502,'目录返回格式无效');}if(!Array.isArray(payload.results))fail(502,'目录结果格式无效');
 const items=payload.results.filter(e=>e.kind==='podcast-episode').slice(0,50).map(e=>({title:text(e.trackName).slice(0,1000),description:String(e.description||e.shortDescription||'').slice(0,40000),publisher_text:String(e.description||e.shortDescription||'').slice(0,40000),audio:https(e.episodeUrl),source:https(e.trackViewUrl).replace(/\/(us|cn)\//,'/'),feed_url:https(e.feedUrl),collection_id:String(e.collectionId||'').slice(0,50),track_id:String(e.trackId||'').slice(0,50),guid:String(e.episodeGuid||'').slice(0,1000),show:text(e.collectionName).slice(0,300),date:String(e.releaseDate||'').slice(0,50),lang:'未标注',version:'目录单集',duration:Math.round((e.trackTimeMillis||0)/1000)}));
 const fetched_at=now();await db.prepare('INSERT INTO discovery_cache(key,data,fetched_at,expires) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at,expires=excluded.expires').bind(key,JSON.stringify(items),fetched_at,Date.now()+24*3600000).run();return {items,cached:false,fetched_at};
}
export async function stepPerson(db,id,fetcher=fetch){
 const row=await one(db,'SELECT * FROM tracking_people WHERE id=?',[id]);if(!row)fail(404,'追踪人物不存在');if(!row.enabled)fail(409,'该人物已暂停追踪');
 const token=crypto.randomUUID(),key='person:'+id;
 const lease=await one(db,'INSERT INTO intake_leases(key,token,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE expires<? RETURNING token',[key,token,Date.now()+120000,Date.now()]);if(lease?.token!==token)fail(409,'人物任务正在处理，请稍后刷新');
 try{
  const current=await one(db,'SELECT * FROM tracking_jobs WHERE person_id=?',[id]);if(!current)fail(404,'请先开始人物追踪');if(current.status!=='pending')return job(current);
  const data=JSON.parse(current.data),query=data.queries[data.position],p=JSON.parse(row.data);if(!query)return job(current);
  const everyone=(await all(db,'SELECT id,data FROM tracking_people')).map(x=>JSON.parse(x.data));const publicPeople=(await all(db,'SELECT id,data FROM people')).map(x=>({...JSON.parse(x.data),id:x.id}));for(const person of publicPeople)if(!everyone.some(x=>x.id===person.id))everyone.push(person);
  try{
   const result=await searchEpisodes(db,query.term,query.country,fetcher);query.cached=result.cached;query.fetched_at=result.fetched_at;query.count=result.items.length;query.capped=result.items.length===50;query.status='completed';
   for(const item of result.items){
    if(!aliases(p).some(n=>containsName(item.title+'\n'+item.description,n))){data.skipped++;continue;}
    // Metadata's feed URL is stored for diagnostics only, never blindly fetched as a server URL.
    const existingSource=SOURCE_DEFINITIONS.find(s=>s.url===item.feed_url);const sourceId=existingSource?.id||'discovered-'+(await hash(item.feed_url||'apple:'+item.collection_id)).slice(0,24);
    const source={id:sourceId,name:item.show,url:item.feed_url||item.source,discovery:'apple',fetch_mode:existingSource?'registered_rss':'directory_metadata',collection_id:item.collection_id};
    const sourceExists=await one(db,'SELECT id FROM intake_sources WHERE id=?',[sourceId]);if(!sourceExists){await db.prepare("INSERT OR IGNORE INTO intake_sources(id,data,enabled,last_status,last_run_at,next_run_at) VALUES(?,?,0,'discovered',?,0)").bind(sourceId,JSON.stringify(source),now()).run();data.sources++;}
    const idKey=item.guid&&item.collection_id?'guid:'+item.collection_id+':'+item.guid:item.audio?'audio:'+item.audio:'apple:'+item.track_id;
    if(!item.guid&&!item.audio&&!item.track_id)continue;
    const candidateId=await hash('discovery|'+p.id+'|'+idKey),fingerprint=await hash(JSON.stringify({item,p,identities:everyone.map(x=>({id:x.id,names:aliases(x)})).sort((a,b)=>a.id.localeCompare(b.id)),rule:RULE_VERSION})),prior=await one(db,'SELECT fingerprint FROM intake_candidates WHERE id=?',[candidateId]);if(prior?.fingerprint===fingerprint)continue;
    const decision=decide({...item,description:item.description.replace(/<\/?(?:p|div|br)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'')},p,everyone);
    const snap=crypto.randomUUID(),stored={item,person:p,source,decision,mode:'shadow',discovery:{provider:'Apple Podcasts',term:query.term,country:query.country,fetched_at:result.fetched_at}};
    const enabled=await one(db,'SELECT enabled FROM tracking_people WHERE id=?',[id]);if(!enabled?.enabled)fail(409,'人物追踪已暂停');
    const fence=await one(db,'SELECT token FROM intake_leases WHERE key=? AND token=? AND expires>?',[key,token,Date.now()]);if(!fence)fail(409,'任务租约已过期，请继续搜索');
    await db.batch([db.prepare('INSERT INTO intake_snapshots(id,candidate_id,run_id,fingerprint,data,created_at) VALUES(?,?,?,?,?,?)').bind(snap,candidateId,current.run_id,fingerprint,JSON.stringify(stored),now()),db.prepare('INSERT INTO intake_candidates(id,source_id,person_id,title,status,reason,fingerprint,snapshot_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,status=excluded.status,reason=excluded.reason,fingerprint=excluded.fingerprint,snapshot_id=excluded.snapshot_id,updated_at=excluded.updated_at').bind(candidateId,sourceId,p.id,item.title,decision.status,decision.reason,fingerprint,snap,now())]);data.changed++;
   }
  }catch(error){console.warn('person_discovery_failed',error.name,error.message);query.status='failed';query.error=error.publicMessage||'目录连接失败，其他查询继续；可以重新更新';}
  data.position++;
  let status=data.position>=data.queries.length?(data.queries.every(q=>q.status==='failed')?'failed':data.queries.some(q=>q.status==='failed')?'partial':'completed'):'pending';
  const enabled=await one(db,'SELECT enabled FROM tracking_people WHERE id=?',[id]);if(!enabled?.enabled)status='cancelled';
  await db.prepare('UPDATE tracking_jobs SET status=?,data=?,updated_at=? WHERE person_id=? AND run_id=?').bind(status,JSON.stringify(data),now(),id,current.run_id).run();
  if(status!=='pending')await db.prepare('UPDATE tracking_people SET next_run_at=? WHERE id=?').bind(Date.now()+(status==='completed'?24:1)*3600000,id).run();
  return job(await one(db,'SELECT * FROM tracking_jobs WHERE person_id=?',[id]));
 }finally{await db.prepare('DELETE FROM intake_leases WHERE key=? AND token=?').bind(key,token).run();}
}
export async function trackingState(db){const people=await all(db,'SELECT * FROM tracking_people ORDER BY created_at DESC');const jobs=await all(db,'SELECT * FROM tracking_jobs');return {people:people.map(p=>({...JSON.parse(p.data),enabled:!!p.enabled,next_run_at:p.next_run_at,job:job(jobs.find(j=>j.person_id===p.id))})),provider:'Apple Podcasts 中美目录',limit_per_query:50,cache_hours:24,scheduler:'not_connected'};}
export async function personDetail(db,id){
 const row=await one(db,'SELECT * FROM tracking_people WHERE id=?',[id]);if(!row)fail(404,'追踪人物不存在');
 const known=await all(db,"SELECT e.* FROM episodes e WHERE person_id=? AND status='approved' AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.episode_id=e.id)",[id]);
 const cs=await all(db,'SELECT c.*,s.data FROM intake_candidates c JOIN intake_snapshots s ON s.id=c.snapshot_id WHERE c.person_id=? ORDER BY c.updated_at DESC LIMIT 500',[id]);
 const groups=[];for(const c of cs){const d=JSON.parse(c.data),item=d.item;if(known.some(e=>{const k=JSON.parse(e.data);return !!item.audio&&k.audio===item.audio||!!item.guid&&k.guid===item.guid;}))continue;
 const key=item.audio||item.guid&&c.source_id+':'+item.guid||item.source||c.id;const existing=groups.find(g=>g.key===key);if(existing){existing.alternate_evidence.push(c.id);continue;}groups.push({...c,data:undefined,key,item,decision:d.decision,alternate_evidence:[]});}
 return {person:{...JSON.parse(row.data),enabled:!!row.enabled},job:job(await one(db,'SELECT * FROM tracking_jobs WHERE person_id=?',[id])),confirmed:known.map(e=>({...JSON.parse(e.data),id:e.id,evidence:e.evidence})),candidates:groups,total_candidates:cs.length,truncated:cs.length===500,coverage:{provider:'Apple Podcasts 中美目录',not_connected:['Spotify 站内搜索','小宇宙站内搜索','网页搜索'],limit_per_query:50,complete:false}};
}
export async function personApi(request,db,path,body){
 if(request.method==='GET'&&path==='/api/admin/person-detail')return personDetail(db,new URL(request.url).searchParams.get('id')||'');
 if(request.method!=='POST')return null;
 if(path==='/api/admin/track'){const p=await trackPerson(db,body);return {person:p,job:await startPerson(db,p.id)};}
 if(path==='/api/admin/person-run')return startPerson(db,field(body.id||''));
 if(path==='/api/admin/person-step')return stepPerson(db,field(body.id||''));
 if(path==='/api/admin/person-toggle'){const id=field(body.id||'');if(typeof body.enabled!=='boolean')fail(400,'追踪设置无效');if(!await one(db,'SELECT id FROM tracking_people WHERE id=?',[id]))fail(404,'追踪人物不存在');await db.batch([db.prepare('UPDATE tracking_people SET enabled=? WHERE id=?').bind(body.enabled?1:0,id),db.prepare("UPDATE tracking_jobs SET status='cancelled',updated_at=? WHERE person_id=? AND status='pending' AND ?=0").bind(now(),id,body.enabled?1:0)]);return {ok:true};}
 return null;
}
export async function tickPeople(db){const pending=await one(db,"SELECT p.id FROM tracking_people p JOIN tracking_jobs j ON j.person_id=p.id WHERE p.enabled=1 AND j.status='pending' ORDER BY j.updated_at LIMIT 1");if(pending)return stepPerson(db,pending.id);const due=await one(db,'SELECT id FROM tracking_people WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 1',[Date.now()]);if(!due)return {status:'not_due'};await startPerson(db,due.id);return stepPerson(db,due.id);}
