import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {SOURCE_DEFINITIONS} from './intake-rules.js';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status,publicMessage:message});};
const digest=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
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
