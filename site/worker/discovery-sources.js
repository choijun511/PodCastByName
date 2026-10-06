import {fetchFeed} from './rss.js';
import {SOURCE_DEFINITIONS,aliases,containsName,norm} from './intake-rules.js';
const one=(db,q,a=[])=>db.prepare(q).bind(...a).first();
const fail=message=>{throw Object.assign(new Error(message),{status:502,publicMessage:message});};
const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const safe=s=>{try{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}};
const text=s=>String(s||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
export async function independentSearch(db,query,person,fetcher=fetch){
 const key=await hash('independent-v1|'+query.provider+'|'+(query.source_id||norm(query.term))+'|'+(query.provider==='rss'?aliases(person).join('|'):''));
 const cached=await one(db,'SELECT * FROM discovery_cache WHERE key=? AND expires>?',[key,Date.now()]);
 if(cached)return {...JSON.parse(cached.data),cached:true,fetched_at:cached.fetched_at};
 let result;
 if(query.provider==='rss'){
  const source=SOURCE_DEFINITIONS.find(s=>s.id===query.source_id);if(!source)fail('未登记的 RSS 来源');
  const registered=await one(db,'SELECT enabled FROM intake_sources WHERE id=?',[source.id]);if(registered&& !registered.enabled)fail('此 RSS 来源已暂停；其他来源继续');
  const feed=await fetchFeed(source,fetcher);
  result={items:feed.items.filter(i=>aliases(person).some(n=>containsName(i.title+'\n'+i.description,n))).slice(0,100).map(i=>({...i,feed_url:source.url,collection_id:'rss:'+source.id})),scanned:feed.items.length,provider:'发布方 RSS',capped:false};
  result.capped=result.items.length===100;
 }else{
  const gate=await one(db,"SELECT value FROM meta WHERE key='podcastindex-search-gate'");
  if(gate&&Number(gate.value)>Date.now())fail('Podcast Index 通道冷却中；其他来源继续');
  const budget=await one(db,'INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<6 RETURNING count',['podcastindex-minute:'+Math.floor(Date.now()/60000),Date.now()+120000]);if(!budget)fail('Podcast Index 每分钟6次预算已用完；稍后更新会复用已完成查询');
  // Official hosted public API, using the independent Podcast Index provider, never its iTunes proxy.
  const u=new URL('https://search.pinepods.online/api/search');u.search=new URLSearchParams({query:query.term,index:'podcastindex',search_type:'person'});
  const r=await fetcher(u.href,{redirect:'manual',signal:AbortSignal.timeout(20000),headers:{Accept:'application/json'}});
  if(!r.ok){if([403,429,503].includes(r.status)){const raw=r.headers.get('retry-after'),wait=/^\d+$/.test(raw||'')?Number(raw)*1000:Math.max(0,Date.parse(raw||'')-Date.now())||0;await db.prepare("INSERT INTO meta(key,value) VALUES('podcastindex-search-gate',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(Date.now()+Math.max(15*60000,wait))).run();}await r.body?.cancel();fail('Podcast Index 返回 HTTP '+r.status+'；其他来源继续');}
  const reader=r.body?.getReader();if(!reader)fail('Podcast Index 返回空响应');let size=0,chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)fail('Podcast Index 响应超过2MB');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  const buf=new Uint8Array(size);let off=0;for(const c of chunks){buf.set(c,off);off+=c.length;}
  let d;try{d=JSON.parse(new TextDecoder().decode(buf));}catch{fail('Podcast Index 响应格式无效');}
  if(!Array.isArray(d.items)||![true,'true'].includes(d.status))fail('Podcast Index 没有返回有效单集列表');
  result={items:d.items.slice(0,100).map(e=>({title:text(e.title).slice(0,1000),description:String(e.description||'').slice(0,12000),publisher_text:String(e.description||'').slice(0,12000),audio:safe(e.enclosureUrl),source:safe(e.link),feed_url:safe(e.feedUrl),collection_id:String(e.feedItunesId||'podcastindex:'+e.feedId).slice(0,100),track_id:'podcastindex:'+String(e.id||''),guid:String(e.guid||'').slice(0,1000),show:text(e.feedTitle).slice(0,300),date:Number.isFinite(e.datePublished)&&e.datePublished>0&&e.datePublished<1e11?new Date(e.datePublished*1000).toISOString():'',lang:String(e.feedLanguage||'未标注').slice(0,40),duration:Number(e.duration)||0,version:'Podcast Index 单集'})),provider:'Podcast Index（PinePods 公共服务）',capped:d.items.length>=60};
 }
 const fetched_at=new Date().toISOString();await db.prepare('INSERT INTO discovery_cache(key,data,fetched_at,expires) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at,expires=excluded.expires').bind(key,JSON.stringify(result),fetched_at,Date.now()+24*3600000).run();return {...result,cached:false,fetched_at};
}
