import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {SOURCE_DEFINITIONS,RULE_VERSION,aliases,containsName,decide,regression} from './intake-rules.js';
const stamp=()=>new Date().toISOString();
const all=async(db,q,a=[]) => (await db.prepare(q).bind(...a).all()).results;
const one=(db,q,a=[])=>db.prepare(q).bind(...a).first();
const digest=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status,publicMessage:message});};
export async function authorize(request,env){
 const expected=env.INTAKE_ADMIN_TOKEN,provided=request.headers.get('authorization')?.replace(/^Bearer /,'')||'';
 if(!expected||expected.length<40)fail(503,'后台访问凭据尚未配置');
 if(provided.length>256||await digest(provided)!==await digest(expected))fail(401,'管理凭据无效，请重新登录');
}
const arr=x=>x===undefined?[]:Array.isArray(x)?x:[x];
const txt=x=>typeof x==='string'?x:typeof x==='number'?String(x):x?.['#text']||'';
export function plain(s){return String(s||'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<\/?(?:p|div|br|li|h[1-6])\b[^>]*>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();}
const safeLink=s=>{try{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password?s:'';}catch{return '';}};
export function parseFeed(xml){
 if(new TextEncoder().encode(xml).length>4*1024*1024)fail(422,'RSS超过4MB限制');
 if(/<!\s*(DOCTYPE|ENTITY)/i.test(xml))fail(422,'拒绝含实体声明的RSS');
 if(XMLValidator.validate(xml)!==true)fail(422,'RSS格式无效');
 const doc=new XMLParser({ignoreAttributes:false,parseTagValue:false,processEntities:false}).parse(xml);
 const channel=doc.rss?.channel;if(!channel)fail(422,'当前仅接入RSS 2.0源');
 const items=arr(channel.item);if(items.length>3000)fail(422,'RSS单集超过3000条限制');
 return items.map(i=>({title:plain(txt(i.title)).slice(0,1000),description:plain(txt(i['content:encoded'])||txt(i.description)).slice(0,40000),publisher_text:(txt(i['content:encoded'])||txt(i.description)).slice(0,60000),audio:safeLink(arr(i.enclosure).find(e=>/^audio\//.test(e?.['@_type']||''))?.['@_url']||''),source:safeLink(txt(i.link)),guid:txt(i.guid).slice(0,1000),date:txt(i.pubDate).slice(0,100),show:plain(txt(channel.title)).slice(0,200),lang:txt(channel.language).slice(0,40),version:'RSS单集'}));
}
export async function fetchFeed(source,fetcher=fetch){
 // Only exact registered feeds are fetched. Redirects fail closed; no user supplied network destination.
 if(!SOURCE_DEFINITIONS.some(s=>s.id===source.id&&s.url===source.url))fail(422,'来源未在已注册RSS列表中');
 const response=await fetcher(source.url,{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Accept:'application/rss+xml, application/xml, text/xml'}});
 if(response.status!==200)fail(502,'来源返回HTTP '+response.status+'；重定向需重新验证来源');
 if(Number(response.headers.get('content-length'))>4*1024*1024)fail(422,'RSS超过4MB限制');
 const reader=response.body?.getReader();if(!reader)fail(502,'RSS内容为空');let size=0,parts=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4*1024*1024)fail(422,'RSS超过4MB限制');parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const buffer=new Uint8Array(size);let at=0;for(const p of parts){buffer.set(p,at);at+=p.length;}
 const xml=new TextDecoder().decode(buffer);return {items:parseFeed(xml),hash:await digest(xml),bytes:size};
}
export async function initializeIntake(db){await db.batch(SOURCE_DEFINITIONS.map(s=>db.prepare("INSERT OR IGNORE INTO intake_sources(id,data,enabled,last_status,last_run_at,next_run_at) VALUES(?,?,1,'never','',0)").bind(s.id,JSON.stringify(s))));}
export async function runSource(db,sourceId,trigger='admin',fetcher=fetch){
 await initializeIntake(db);const sourceRow=await one(db,'SELECT * FROM intake_sources WHERE id=?',[sourceId]);if(!sourceRow)fail(404,'来源不存在');if(!sourceRow.enabled)fail(409,'来源已暂停');
 const token=crypto.randomUUID(),time=Date.now();
 const lock=await one(db,"INSERT INTO intake_leases(key,token,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE intake_leases.expires<? RETURNING token",['source:'+sourceId,token,time+120000,time]);
 if(lock?.token!==token)fail(409,'该来源正在运行，请稍后刷新');
 await db.prepare("UPDATE intake_runs SET status='interrupted',finished_at=? WHERE source_id=? AND status='running' AND created_at<?").bind(stamp(),sourceId,new Date(time-120000).toISOString()).run();
 const id='run-'+crypto.randomUUID(),created=stamp(),source=JSON.parse(sourceRow.data);let summary={scanned:0,matched:0,changed:0,cached:0,shadow_pass:0,deferred:0,rejected:0,published:0,model_calls:0};
 await db.prepare('INSERT INTO intake_runs(id,source_id,trigger,status,summary,created_at,finished_at) VALUES(?,?,?,?,?,?,?)').bind(id,sourceId,trigger,'running',JSON.stringify(summary),created,'').run();
 try{
  const feed=await fetchFeed(source,fetcher);summary.scanned=feed.items.length;summary.feed_hash=feed.hash;summary.bytes=feed.bytes;
  const people=(await all(db,'SELECT * FROM people')).map(p=>({...JSON.parse(p.data),id:p.id}));
  // Re-evaluate all matching entries after text changes; cached decisions have immutable evidence.
  const matches=[];for(const item of feed.items)for(const p of people)if(aliases(p).some(n=>containsName(item.title+'\n'+item.description,n)))matches.push({item,p});
  if(matches.length>200)fail(422,'匹配项超过单次200条限制，需拆分来源后重试');summary.matched=matches.length;
  for(const {item,p} of matches){
   if(Date.now()-time>90000)fail(504,'本次运行达到90秒上限，已保存进度，下次会复用');
   const candidateId=await digest(sourceId+'\n'+(item.guid||item.audio||item.source||item.title)+'\n'+p.id);
   const fingerprint=await digest(JSON.stringify({item,person:p,people:people.map(p=>({id:p.id,names:aliases(p)})),rule:RULE_VERSION}));
   const current=await one(db,'SELECT * FROM intake_candidates WHERE id=?',[candidateId]);
   if(current?.fingerprint===fingerprint){summary.cached++;continue;}
   const decision=decide(item,p,people),snapshotId=crypto.randomUUID(),when=stamp();
   const existing=(await all(db,'SELECT id,data FROM episodes WHERE person_id=?',[p.id])).find(e=>JSON.parse(e.data).audio===item.audio);
   const hidden=existing&&await one(db,'SELECT episode_id FROM hidden WHERE episode_id=?',[existing.id]);
   if(hidden){decision.status='deferred';decision.reason='withdrawn_stays_hidden';}summary[decision.status]++;
   const stored={item,person:{id:p.id,name:p.name,alias:p.alias},source,decision,existing_episode_id:existing?.id||null,feed_hash:feed.hash,mode:'shadow'};
   // Lease fencing and immutable evidence + current pointer commit atomically.
   const lease=await one(db,'SELECT token FROM intake_leases WHERE key=? AND token=? AND expires>?',['source:'+sourceId,token,Date.now()]);if(!lease)fail(409,'运行租约已过期，下次运行会恢复');
   await db.batch([
    db.prepare('INSERT INTO intake_snapshots(id,candidate_id,run_id,fingerprint,data,created_at) VALUES(?,?,?,?,?,?)').bind(snapshotId,candidateId,id,fingerprint,JSON.stringify(stored),when),
    db.prepare('INSERT INTO intake_candidates(id,source_id,person_id,title,status,reason,fingerprint,snapshot_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,status=excluded.status,reason=excluded.reason,fingerprint=excluded.fingerprint,snapshot_id=excluded.snapshot_id,updated_at=excluded.updated_at').bind(candidateId,sourceId,p.id,item.title,decision.status,decision.reason,fingerprint,snapshotId,when)
   ]);summary.changed++;
  }
  await db.batch([
   db.prepare("UPDATE intake_runs SET status='completed',summary=?,finished_at=? WHERE id=?").bind(JSON.stringify(summary),stamp(),id),
   db.prepare("UPDATE intake_sources SET last_status='ok',last_run_at=?,next_run_at=? WHERE id=?").bind(stamp(),Date.now()+6*3600000,sourceId)
  ]);
 }catch(error){summary.error=error.publicMessage||'来源抓取或处理失败，将保留已有证据后重试';await db.batch([
  db.prepare("UPDATE intake_runs SET status='failed',summary=?,finished_at=? WHERE id=?").bind(JSON.stringify(summary),stamp(),id),
  db.prepare("UPDATE intake_sources SET last_status='error',last_run_at=?,next_run_at=? WHERE id=?").bind(stamp(),Date.now()+3600000,sourceId)
 ]);}finally{await db.prepare('DELETE FROM intake_leases WHERE key=? AND token=?').bind('source:'+sourceId,token).run();}
 return one(db,'SELECT * FROM intake_runs WHERE id=?',[id]);
}
export async function tick(db,fetcher=fetch){await initializeIntake(db);await db.prepare("UPDATE intake_runs SET status='interrupted',finished_at=? WHERE status='running' AND created_at<?").bind(stamp(),new Date(Date.now()-120000).toISOString()).run();const sources=await all(db,'SELECT id FROM intake_sources WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at,id LIMIT 1',[Date.now()]);return sources.length?runSource(db,sources[0].id,'scheduler',fetcher):{status:'not_due'};}
export async function adminApi(request,env,path,readBody){
 await authorize(request,env);const db=env.DB;await initializeIntake(db);
 if(request.method==='GET'&&path==='/api/admin/state'){
  const [sources,runs,counts,candidates,evaluations,feedback]=await Promise.all([
   all(db,'SELECT * FROM intake_sources ORDER BY id'),all(db,'SELECT * FROM intake_runs ORDER BY created_at DESC LIMIT 30'),all(db,'SELECT status,COUNT(*) AS n FROM intake_candidates GROUP BY status'),all(db,'SELECT * FROM intake_candidates ORDER BY updated_at DESC LIMIT 100'),all(db,'SELECT * FROM intake_evaluations ORDER BY created_at DESC LIMIT 5'),all(db,"SELECT e.id,e.person_id,e.data,COUNT(v.client_hash) AS votes,SUM(v.value='no') AS negative,h.hidden_at FROM episodes e JOIN votes v ON v.episode_id=e.id LEFT JOIN hidden h ON h.episode_id=e.id GROUP BY e.id ORDER BY negative DESC")
  ]);
  return {mode:'shadow',rule_version:RULE_VERSION,generated_at:stamp(),sources:sources.map(s=>({...s,...JSON.parse(s.data),data:undefined})),runs:runs.map(r=>({...r,summary:JSON.parse(r.summary)})),counts,candidates,evaluations:evaluations.map(e=>({...e,result:JSON.parse(e.result)})),feedback:feedback.map(f=>({...f,title:JSON.parse(f.data).title,data:undefined})),gates:{publication:'blocked_reference_benchmark',accuracy:null,model:'disabled_no_cost',scheduler:'not_connected',coverage:'3 registered RSS feeds; existing people only',explanation:'规则仅产生影子候选；尚未接入独立真实标注集，不宣称99%准确率。定时触发接口已实现，云端调度尚未连接。'}};
 }
 if(request.method==='GET'&&path==='/api/admin/evidence'){
  const id=new URL(request.url).searchParams.get('id')||'';const history=await all(db,'SELECT * FROM intake_snapshots WHERE candidate_id=? ORDER BY created_at DESC LIMIT 20',[id]);if(!history.length)fail(404,'证据不存在');return {history:history.map(s=>({...s,data:JSON.parse(s.data)}))};
 }
 if(request.method==='POST'){
  const data=await readBody(request);
  if(path==='/api/admin/run'){if(typeof data.source_id!=='string')fail(400,'请选择来源');const r=await runSource(db,data.source_id);return {...r,summary:JSON.parse(r.summary)};}
  if(path==='/api/admin/tick')return tick(db);
  if(path==='/api/admin/source'){
   if(typeof data.enabled!=='boolean'||!SOURCE_DEFINITIONS.some(s=>s.id===data.id))fail(400,'来源设置无效');
   await db.prepare('UPDATE intake_sources SET enabled=? WHERE id=?').bind(data.enabled?1:0,data.id).run();return {ok:true};
  }
  if(path==='/api/admin/validate'){const result=regression();await db.prepare('INSERT INTO intake_evaluations(id,result,created_at) VALUES(?,?,?)').bind(crypto.randomUUID(),JSON.stringify(result),stamp()).run();return result;}
  if(path==='/api/admin/publish')fail(409,'未通过独立真实样本验证，自动发布保持关闭');
 }
 fail(404,'管理接口不存在');
}
