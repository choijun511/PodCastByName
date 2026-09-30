import {adminApi,tick} from './intake.js';
import catalog from './catalog.json' with {type:'json'};
import assets from './assets.json' with {type:'json'};

class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
const normalize=s=>s.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
const now=()=>new Date().toISOString();
const bounded=(s,label,max,required=false)=>{if(typeof s!=='string'||s.length>max||(required&&!s.trim()))throw new HttpError(400,label+'格式无效');return s.trim();};
const integer=(raw,fallback,min,max)=>{if(raw===null)return fallback;if(!/^\d+$/.test(raw))throw new HttpError(400,'分页参数无效');const n=Number(raw);if(!Number.isSafeInteger(n)||n<min||n>max)throw new HttpError(400,'分页参数超出范围');return n;};
const sha=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');
async function clientHash(key){if(typeof key!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(key))throw new HttpError(400,'需要有效的设备凭据');return sha(key);}
function dbFor(env){if(!env.DB)throw new HttpError(503,'目录服务暂不可用，请稍后重试');return env.DB;}
async function rows(db,sql,args=[]){return (await db.prepare(sql).bind(...args).all()).results;}
async function first(db,sql,args=[]){return db.prepare(sql).bind(...args).first();}
async function initialize(db){
 if(await first(db,"SELECT value FROM meta WHERE key='catalog-v1'"))return;
 // Seed is a reviewed public snapshot, separate from schema migrations. Never overwrite moderation.
 const statements=catalog.people.map(p=>db.prepare('INSERT OR IGNORE INTO people(id,data) VALUES(?,?)').bind(p.id,JSON.stringify(p.data)));
 for(const e of catalog.episodes)statements.push(db.prepare('INSERT OR IGNORE INTO episodes(id,person_id,data,evidence,seq,approved_at,status) VALUES(?,?,?,?,?,?,?)').bind(e.id,e.person_id,JSON.stringify(e.data),e.evidence,e.seq,e.approved_at,'approved'));
 statements.push(db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('catalog-v1','1')"));
 await db.batch(statements);
}
async function visibleEpisodes(db){return rows(db,"SELECT e.*,COALESCE(SUM(v.value='yes'),0) AS yes,COALESCE(SUM(v.value='no'),0) AS no FROM episodes e LEFT JOIN votes v ON v.episode_id=e.id WHERE e.status='approved' AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.episode_id=e.id) GROUP BY e.id ORDER BY e.seq");}
function episode(row){return {...JSON.parse(row.data),id:row.id,evidence:row.evidence,votes:{yes:row.yes||0,no:row.no||0,total:(row.yes||0)+(row.no||0),hidden:false,threshold:3}};}
async function peopleList(db){const [ps,es]=await Promise.all([rows(db,'SELECT * FROM people ORDER BY rowid'),visibleEpisodes(db)]);return ps.map(p=>({...JSON.parse(p.data),id:p.id,episodes:es.filter(e=>e.person_id===p.id).map(episode)})).filter(p=>p.episodes.length);}
const names=p=>[p.name,...(p.alias||'').split(/[,，;；|]/)].filter(Boolean).map(normalize);
function sameRelease(a,b){if(a.audio===b.audio)return true;try{const x=new URL(a.source),y=new URL(b.source);return x.hostname===y.hostname&&x.pathname.replace(/\/$/,'')===y.pathname.replace(/\/$/,'')&&normalize(a.title)===normalize(b.title);}catch{return false;}}
async function updates(db,params){
 const after=integer(params.get('after'),0,0,Number.MAX_SAFE_INTEGER),limit=integer(params.get('limit'),50,1,100),ids=(params.get('people')||'').split(',').filter(Boolean);
 if(ids.length>100||ids.some(id=>!/^[\w-]{1,100}$/.test(id)))throw new HttpError(400,'人物参数无效');
 const latest=(await first(db,'SELECT COALESCE(MAX(seq),0) AS n FROM episodes')).n;
 const groups=[];if(ids.length){const ps=await peopleList(db);const selected=ps.filter(p=>ids.includes(p.id));const es=await visibleEpisodes(db);
 for(const row of es){const p=selected.find(p=>p.id===row.person_id);if(!p)continue;const e=episode(row);let group=groups.find(g=>sameRelease(g.episode,e));
 if(!group){group={id:'update-'+row.seq,seq:row.seq,people:[],episode:e,approved_at:row.approved_at};groups.push(group);}
 const member=group.people.find(x=>x.id===p.id);if(member)member.seq=Math.max(member.seq,row.seq);else group.people.push({id:p.id,name:p.name,seq:row.seq});
 if(row.seq>=group.seq){group.seq=row.seq;group.approved_at=row.approved_at;}
 }}
 const filtered=groups.filter(g=>g.seq>after).sort((a,b)=>a.seq-b.seq),items=filtered.slice(0,limit);
 for(const g of items){const published=Date.parse(g.episode.date),approval=Date.parse(g.approved_at);g.kind=published>=approval-7*864e5&&published<=approval+864e5?'new_release':'backfill';}
 const has_more=filtered.length>limit;return {items,cursor:has_more?items.at(-1).seq:Math.max(latest,after),latest_cursor:latest,has_more};
}
async function readBody(request){
 if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new HttpError(415,'需要JSON请求');
 if(Number(request.headers.get('content-length'))>16384)throw new HttpError(413,'请求内容过大');
 const reader=request.body?.getReader();if(!reader)throw new HttpError(400,'请求内容为空');let size=0,chunks=[];
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw new HttpError(413,'请求内容过大');}chunks.push(value);}
 const buffer=new Uint8Array(size);let at=0;for(const chunk of chunks){buffer.set(chunk,at);at+=chunk.length;}
 try{const data=JSON.parse(new TextDecoder().decode(buffer));if(!data||Array.isArray(data)||typeof data!=='object')throw Error();return data;}catch{throw new HttpError(400,'JSON格式无效');}
}
async function limitWrites(db,request,hash){
 const hour=Math.floor(Date.now()/3600000),ip=request.headers.get('cf-connecting-ip');
 const keys=['device:'+hash+':'+hour];if(ip)keys.push('network:'+await sha(ip+':'+hour));
 const results=await db.batch(keys.map(key=>db.prepare('INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key,(hour+2)*3600000)));
 await db.prepare('DELETE FROM rate_limits WHERE expires<?').bind(Date.now()).run();
 if(results.some(r=>r.results[0].count>120))throw new HttpError(429,'操作过于频繁，请稍后再试');
}
function requestItem(r){return {id:r.id,query:r.query,identity_hint:r.identity_hint,status:r.status,note:r.note,person_id:r.person_id,created_at:r.created_at,updated_at:r.updated_at,history:[{status:r.status,note:r.note,person_id:r.person_id,created_at:r.updated_at}]};}
async function requestsFor(db,hash){return (await rows(db,'SELECT * FROM requests WHERE client_hash=? ORDER BY created_at DESC,id LIMIT 200',[hash])).map(requestItem);}
async function submitRequest(db,data,hash){
 const query=bounded(data.query,'人物姓名',200,true),hint=bounded(data.identity_hint??'','身份线索',1000),key=normalize(query),hintKey=normalize(hint);
 const existing=await first(db,'SELECT * FROM requests WHERE client_hash=? AND query_key=? AND hint_key=?',[hash,key,hintKey]);if(existing)return {request:requestItem(existing),created:false};
 const id='request-'+crypto.randomUUID(),stamp=now(),cutoff=new Date(Date.now()-864e5).toISOString();
 await db.prepare("INSERT OR IGNORE INTO requests(id,client_hash,query,identity_hint,query_key,hint_key,status,note,person_id,created_at,updated_at) SELECT ?,?,?,?,?,?,'queued','已保存需求。入库正在影子验证，尚未开放新人物自动发布，暂不承诺补录时间。','',?,? WHERE (SELECT COUNT(*) FROM requests WHERE client_hash=? AND created_at>=?)<20 AND (SELECT COUNT(*) FROM requests WHERE client_hash=?)<200").bind(id,hash,query,hint,key,hintKey,stamp,stamp,hash,cutoff,hash).run();
 const result=await first(db,'SELECT * FROM requests WHERE client_hash=? AND query_key=? AND hint_key=?',[hash,key,hintKey]);if(!result)throw new HttpError(429,'补录请求已达本设备限额，请稍后再试');return {request:requestItem(result),created:result.id===id};
}
async function vote(db,data,hash){
 const id=bounded(data.id,'出场ID',200,true),value=data.value;if(!['yes','no'].includes(value))throw new HttpError(400,'投票值无效');
 const item=await first(db,"SELECT id FROM episodes WHERE id=? AND (status='approved' OR EXISTS(SELECT 1 FROM hidden WHERE episode_id=episodes.id))",[id]);if(!item)throw new HttpError(404,'出场不存在');
 const stamp=now(),cutoff=new Date(Date.now()-864e5).toISOString();
 // Batch is atomic: device quota, vote change, and sticky withdrawal share a transaction.
 const result=await db.batch([
 db.prepare("INSERT INTO votes(episode_id,client_hash,value,created_at,updated_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM votes WHERE episode_id=? AND client_hash=?) OR (SELECT COUNT(*) FROM votes WHERE client_hash=? AND created_at>=?)<20 ON CONFLICT(episode_id,client_hash) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(id,hash,value,stamp,stamp,id,hash,hash,cutoff),
 db.prepare("INSERT OR IGNORE INTO hidden(episode_id,hidden_at) SELECT ?,? WHERE (SELECT COUNT(*) FROM votes WHERE episode_id=? AND value='no')>=3 AND (SELECT COUNT(*) FROM votes WHERE episode_id=? AND value='no')*3 >= (SELECT COUNT(*) FROM votes WHERE episode_id=?)*2").bind(id,stamp,id,id,id),
 db.prepare("SELECT COALESCE(SUM(value='yes'),0) AS yes,COALESCE(SUM(value='no'),0) AS no,COUNT(*) AS total FROM votes WHERE episode_id=?").bind(id),
 db.prepare('SELECT value FROM votes WHERE episode_id=? AND client_hash=?').bind(id,hash),
 db.prepare('SELECT episode_id FROM hidden WHERE episode_id=?').bind(id)
 ]);
 const mine=result[3].results[0]?.value;if(!mine)throw new HttpError(429,'此设备24小时内最多评价20条新出场');
 return {...result[2].results[0],mine,hidden:result[4].results.length>0,threshold:3};
}
const headers={
 'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=()',
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'"
};
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});}
export default {async scheduled(event,env,ctx){ctx.waitUntil((async()=>{const db=dbFor(env);await initialize(db);await tick(db);})());},async fetch(request,env){
 try{
 const url=new URL(request.url),path=url.pathname;

 if(!path.startsWith('/api/')){
  if(!['GET','HEAD'].includes(request.method))return json({error:'请求方法不支持'},405);
  const asset=assets[path==='/'?'/index.html':path];if(!asset)return json({error:'页面不存在'},404);
  return new Response(request.method==='HEAD'?null:asset.body,{headers:{...headers,'Content-Type':asset.type,'Cache-Control':'no-cache'}});
 }
 if(!['GET','POST'].includes(request.method))throw new HttpError(405,'请求方法不支持');
 const origin=request.headers.get('origin');if(origin&&origin!==url.origin)throw new HttpError(403,'禁止跨来源访问');
 if(request.method==='POST'&&request.headers.get('sec-fetch-site')==='cross-site')throw new HttpError(403,'禁止跨来源写入');
 const db=dbFor(env);await initialize(db);
 if(path.startsWith('/api/admin/'))return json(await adminApi(request,env,path,readBody));
 if(request.method==='GET'){
  if(path==='/api/health')return json({service:'tingshui',status:'ok',mode:'online'});
  if(path==='/api/people')return json(await peopleList(db));
  if(path==='/api/search'){
   const query=normalize(bounded(url.searchParams.get('q')||'','搜索词',200)),limit=integer(url.searchParams.get('limit'),20,1,100),offset=integer(url.searchParams.get('offset'),0,0,100000);
   const matches=(await peopleList(db)).filter(p=>!query||names(p).some(n=>n.includes(query))).sort((a,b)=>Number(!names(a).includes(query))-Number(!names(b).includes(query))||normalize(a.name).localeCompare(normalize(b.name))||a.id.localeCompare(b.id));
   return json({items:matches.slice(offset,offset+limit),total:matches.length,limit,offset});
  }
  if(path==='/api/updates')return json(await updates(db,url.searchParams));
  if(path==='/api/requests')return json({requests:await requestsFor(db,await clientHash(request.headers.get('x-client-key')))});
  throw new HttpError(404,'接口不存在');
 }
 if(!['/api/vote','/api/requests','/api/interest'].includes(path))throw new HttpError(404,'接口不存在');
 const data=await readBody(request);
 if(path==='/api/interest'){
  const id=bounded(data.id,'人物ID',100,true);if(!await first(db,'SELECT id FROM people WHERE id=?',[id]))throw new HttpError(404,'人物不存在');
  // A single row/person stores anonymous interest; intake remains paused.
  await db.prepare('INSERT INTO demand(person_id,requested_at) VALUES(?,?) ON CONFLICT(person_id) DO UPDATE SET requested_at=excluded.requested_at').bind(id,now()).run();return json({ok:true});
 }
 const hash=await clientHash(data.client_key);await limitWrites(db,request,hash);
 if(path==='/api/requests')return json(await submitRequest(db,data,hash));
 return json(await vote(db,data,hash));
 }catch(error){if(!error.status)console.error('request_failed',error.name);return json({error:error instanceof HttpError?error.message:error.publicMessage||'服务暂不可用，请稍后重试'},error.status||503);}
}};
