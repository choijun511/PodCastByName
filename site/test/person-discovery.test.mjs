import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './database.mjs';
import worker from '../dist/server/index.js';
import {trackPerson,startPerson,stepPerson,personDetail,searchEpisodes,personApi} from '../worker/person-discovery.js';
const seed=async db=>worker.fetch(new Request('https://test.example/api/health'),{DB:db});
const item={kind:'podcast-episode',trackName:'Jensen Huang interview',description:'Guest: Jensen Huang, NVIDIA CEO',episodeUrl:'https://audio.example/interview.mp3',feedUrl:'https://feed.example/rss',collectionId:123,trackId:456,episodeGuid:'guid-1',trackViewUrl:'https://podcasts.apple.com/us/podcast/id123?i=456',collectionName:'New show',releaseDate:'2026-09-01'};
const response=items=>async u=>u.includes('pinepods.online')?new Response(JSON.stringify({status:'true',items:items.map(e=>({title:e.trackName,description:e.description,enclosureUrl:e.episodeUrl,feedUrl:e.feedUrl,feedItunesId:e.collectionId,id:e.trackId,guid:e.episodeGuid,link:e.trackViewUrl,feedTitle:e.collectionName,datePublished:1788220800}))})):u.includes('itunes.apple.com')?new Response(JSON.stringify({results:items})):new Response('<rss version="2.0"><channel><title>Publisher</title></channel></rss>');
async function finish(db,id,f){let j;do{j=await stepPerson(db,id,f);}while(j.status==='pending');return j;}
async function setup(){const db=database();await seed(db);const p=await trackPerson(db,{name:'黄仁勋'});return {db,p};}
test('one person discovers sources across regions, deduplicates, keeps public directory isolated',async()=>{const {db,p}=await setup();assert.equal(p.id,'jensen');let j=await startPerson(db,p.id);assert.equal(j.data.queries.length,9);assert.equal((await startPerson(db,p.id)).run_id,j.run_id);j=await finish(db,p.id,response([item]));assert.equal(j.status,'completed');assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM intake_candidates').get().n,2);assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM intake_snapshots').get().n,2);assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM intake_sources').get().n,1);assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM episodes').get().n,5);const d=await personDetail(db,p.id);assert.equal(d.confirmed.length,2);assert.equal(d.candidates.length,1);assert.equal(d.coverage.complete,false);});
test('second update reuses shared cache without external requests',async()=>{const {db,p}=await setup();await startPerson(db,p.id);await finish(db,p.id,response([item]));await startPerson(db,p.id);let j;j=await finish(db,p.id,async()=>{throw Error('must not fetch')});assert.equal(j.status,'completed');assert(j.data.queries.every(q=>q.cached));assert.equal(j.data.changed,0);});
test('new identity remains private and pause stops pending task',async()=>{const {db}=await setup();const p=await trackPerson(db,{name:'测试作家',identity_hint:'作家',alias:'Test Author'});assert.equal(p.identity_verified,false);assert.equal((await trackPerson(db,{name:'测试作家',identity_hint:'作家'})).id,p.id);assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM people').get().n,3);await startPerson(db,p.id);await personApi({method:'POST'},db,'/api/admin/person-toggle',{id:p.id,enabled:false});await assert.rejects(()=>stepPerson(db,p.id,response([])),e=>e.status===409);assert.equal(db.sql.prepare('SELECT status FROM tracking_jobs WHERE person_id=?').get(p.id).status,'cancelled');});
test('provider failure retains coverage error while remaining queries complete',async()=>{const {db,p}=await setup();await startPerson(db,p.id);let j=await stepPerson(db,p.id,async()=>new Response('',{status:503}));assert.equal(j.data.queries[0].status,'failed');assert.equal(j.status,'pending');j=await finish(db,p.id,response([]));assert.equal(j.status,'partial');});
test('untrusted feed addresses are not fetched; wrong-name results excluded',async()=>{const {db,p}=await setup();await startPerson(db,p.id);const called=[];await stepPerson(db,p.id,async u=>{called.push(u);return response([{...item,feedUrl:'http://127.0.0.1/private'},{...item,trackName:'Other person',description:'Other',trackId:999,episodeGuid:'other'}])(u);});assert.equal(called.length,1);assert(called[0].startsWith('https://search.pinepods.online/api/search?'));assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM intake_candidates').get().n,1);});
test('concurrent step excluded; person routes require auth; malformed response not cached',async()=>{const {db,p}=await setup();await startPerson(db,p.id);db.sql.prepare('INSERT INTO intake_leases VALUES(?,?,?)').run('person:jensen','another',Date.now()+120000);await assert.rejects(()=>stepPerson(db,p.id,response([])),e=>e.status===409);const r=await worker.fetch(new Request('https://test.example/api/admin/track',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"name":"黄仁勋"}'}),{DB:db,INTAKE_ADMIN_TOKEN:'secret-'.repeat(8)});assert.equal(r.status,401);await assert.rejects(()=>searchEpisodes(db,'someone','us',async()=>new Response('{}')),e=>e.status===502);assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM discovery_cache').get().n,0);});
test('Apple denial never blocks independent discovery or a new person run',async()=>{
 const {db,p}=await setup();await startPerson(db,p.id);let appleCalls=0,indexCalls=0;
 const f=async u=>{if(u.includes('itunes.apple.com')){appleCalls++;return new Response('denied',{status:403});}if(u.includes('pinepods.online'))indexCalls++;return response([item])(u);};
 const j=await finish(db,p.id,f);assert.equal(j.status,'partial');assert.equal(appleCalls,1);assert.equal(indexCalls,2);assert.equal(j.data.queries.filter(q=>q.status==='completed').length,5);assert.equal(j.data.queries.filter(q=>q.status==='not_requested').length,3);
 assert.equal((await personDetail(db,p.id)).candidates.length,1);assert.equal((await personDetail(db,p.id)).confirmed.length,2);
 await startPerson(db,p.id);const again=await finish(db,p.id,f);assert.equal(again.status,'partial');assert.equal(appleCalls,1);assert.equal(indexCalls,2);
});
test('429 honors Retry-After for Apple but does not stop the other providers',async()=>{
 const {db,p}=await setup();await assert.rejects(()=>searchEpisodes(db,'Person','us',async()=>new Response('',{status:429,headers:{'Retry-After':'7200'}})),e=>e.retry_at>=Date.now()+7199e3);
 assert.equal((await startPerson(db,p.id)).status,'pending');let calls=0;
 await assert.rejects(()=>searchEpisodes(db,'Other Person','cn',async()=>{calls++;return new Response('{}')}),e=>e.provider_blocked);assert.equal(calls,0);
 const j=await finish(db,p.id,response([item]));assert.equal(j.status,'partial');assert.equal(j.data.queries[0].status,'completed');
});
test('Podcast Index failure is isolated; RSS evidence still arrives and is cached',async()=>{
 const {db,p}=await setup();await startPerson(db,p.id);let indexCalls=0;
 const f=async u=>{if(u.includes('pinepods.online')){indexCalls++;return new Response('',{status:429});}if(u.includes('itunes.apple.com'))return response([])(u);return new Response('<rss version="2.0"><channel><title>Original Publisher</title><item><title>Jensen Huang</title><description>Guest: Jensen Huang, NVIDIA CEO</description><guid>rss-proof</guid><enclosure type="audio/mpeg" url="https://audio.example/rss.mp3"/></item></channel></rss>');};
 const j=await finish(db,p.id,f);assert.equal(indexCalls,1);assert.equal(j.status,'partial');assert.equal(j.data.queries.filter(q=>q.provider==='rss'&&q.status==='completed').length,3);assert.equal((await personDetail(db,p.id)).candidates.length,1);
 await startPerson(db,p.id);const again=await finish(db,p.id,f);assert(again.data.queries.filter(q=>q.provider==='rss').every(q=>q.cached));
});
test('invalid Podcast Index payload cannot become a successful empty cache',async()=>{
 const {db,p}=await setup();await startPerson(db,p.id);const j=await stepPerson(db,p.id,async()=>new Response('{"status":"false","items":[]}'));assert.equal(j.data.queries[0].status,'failed');assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM discovery_cache').get().n,0);
});

test('syndicated audio keeps separate source evidence and never oscillates on cached runs',async()=>{
 const {db,p}=await setup();const syndicated={...item,collectionId:789,feedUrl:'https://another.example/rss',collectionName:'Syndicated show',description:'Guest: Jensen Huang, NVIDIA CEO. Alternate publisher text.'};
 const f=async u=>u.includes('pinepods.online')?response([item,syndicated])(u):response([])(u);
 await startPerson(db,p.id);await finish(db,p.id,f);let d=await personDetail(db,p.id);assert.equal(d.candidates.length,1);assert.equal(d.candidates[0].alternate_evidence.length,1);
 assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM intake_candidates').get().n,2);
 await startPerson(db,p.id);const j=await finish(db,p.id,async()=>{throw Error('must reuse cache')});assert.equal(j.data.changed,0);assert.equal(j.status,'completed');
});
