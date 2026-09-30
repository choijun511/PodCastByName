/* Isolated browser acceptance: all catalog, demand, updates and audio are fixtures. */
const {chromium}=require('/Users/bytedance/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('assert');
const fs=require('fs');
const base=process.env.TINGSHUI_TEST_URL||'http://127.0.0.1:8765';
const bytes=8000*90*2,wav=Buffer.alloc(44+bytes);
wav.write('RIFF');wav.writeUInt32LE(36+bytes,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(bytes,40);
const person={id:'jensen',name:'黄仁勋',alias:'Jensen Huang',initial:'黄',color:'#dfff00',role:'测试人物',topic:'科技',intro:'隔离测试人物，不写入真实目录。',show:'测试节目',episodes:['trial-a','trial-b'].map((id,i)=>({id,title:'试用测试 '+id,audio:base+'/'+id+'.wav',source:'https://example.com/'+id,date:'2026-09-01',lang:i?'English':'中文',show:'测试节目',version:'测试音源',evidence:'Guest: Jensen Huang joins this fixture interview.'}))};
async function fixture(browser){
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];
 const state={peopleFail:false,healthFail:false,searchMode:'ok',audioFail:false,audioHang:false};
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/api/health')return route.fulfill({status:state.healthFail?503:200,json:{service:'tingshui',status:state.healthFail?'down':'ok'}});
  if(url.pathname==='/api/people')return route.fulfill({status:state.peopleFail?503:200,json:state.peopleFail?{error:'fixture unavailable'}:[person]});
  if(url.pathname==='/api/updates')return route.fulfill({json:{items:[],latest_cursor:0,cursor:0,has_more:false}});
  if(url.pathname==='/api/interest')return route.fulfill({json:{ok:true}});
  if(url.pathname==='/api/search'){
   if(state.searchMode==='hang')return;
   if(state.searchMode==='slow')await new Promise(resolve=>setTimeout(resolve,600));
   return route.fulfill({status:state.searchMode==='fail'?503:200,json:state.searchMode==='fail'?{error:'测试搜索故障'}:{items:[person],total:1,limit:12,offset:0}});
  }
  return route.fulfill({status:404,json:{error:'Unmocked test API '+url.pathname}});
 });
 await page.route('**/trial-*.wav',route=>{
  if(state.audioHang)return;
  if(state.audioFail)return route.abort('failed');
  const range=route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
  if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),wav.length-1):wav.length-1;return route.fulfill({status:206,contentType:'audio/wav',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${wav.length}`},body:wav.subarray(start,end+1)});}
  return route.fulfill({contentType:'audio/wav',headers:{'Accept-Ranges':'bytes'},body:wav});
 });
 return {context,page,state,errors};
}
async function noOverflow(page,label){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label+' horizontal overflow');}
(async()=>{
 fs.mkdirSync('artifacts/visual',{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  let f=await fixture(browser),p=f.page;
  await p.goto(base+'/#discover');await p.locator('#search').fill('Jensen Huang');f.state.searchMode='slow';await p.locator('#search-form button').click();
  await p.getByText('正在搜索已审核人物…',{exact:true}).waitFor();await p.locator('.card a[href="#person/jensen"]').first().click();
  await p.locator('[data-follow=jensen]').click();await p.waitForFunction(()=>JSON.parse(localStorage.getItem('tingshui-v1'))?.following.includes('jensen'));
  await p.locator('[data-queue=trial-a]').click();await p.waitForFunction(()=>JSON.parse(localStorage.getItem('tingshui-v1'))?.queue.includes('trial-a'));
  await p.locator('[data-play=trial-a]').click();await p.waitForFunction(()=>document.querySelector('audio').currentTime>.2);
  await p.locator('#speed').selectOption('1.5');await p.locator('audio').evaluate(a=>a.currentTime=20);await p.waitForFunction(()=>document.querySelector('audio').currentTime>=19);
  await p.locator('[data-nav=library]').click();await p.locator('[data-queue-row=trial-a]').waitFor();assert(await p.locator('audio').evaluate(a=>!a.paused));
  await p.locator('#toggle').click();await p.reload();await p.waitForFunction(()=>document.querySelector('audio').readyState>=1&&document.querySelector('audio').currentTime>=19);
  assert.equal(await p.locator('#speed').inputValue(),'1.5');assert(await p.locator('audio').evaluate(a=>a.paused));
  await p.locator('[data-nav=following]').click();await p.getByRole('heading',{name:'我的人物阵容'}).waitFor();assert.equal(await p.locator('[data-follow=jensen]').count(),1);
  for(const width of [390,320,768]){await p.setViewportSize({width,height:900});await noOverflow(p,'following '+width);await p.screenshot({path:'artifacts/visual/trial-following-'+width+'.png',fullPage:true});}
  const before=await p.evaluate(()=>localStorage.getItem('tingshui-v1'));f.state.healthFail=true;
  await p.evaluate(()=>window.TingshuiConnection.check());await p.locator('#connection-status').waitFor();assert.equal(await p.evaluate(()=>localStorage.getItem('tingshui-v1')),before);
  f.state.healthFail=false;await p.locator('#connection-retry').click();await p.locator('#connection-status').waitFor({state:'hidden'});assert.equal(await p.evaluate(()=>localStorage.getItem('tingshui-v1')),before);
  assert.deepEqual(f.errors,[]);await f.context.close();console.log('TRIAL_SEARCH_FOLLOW_AUDIO_QUEUE_RELOAD_SPEED_RESPONSIVE_RECONNECT_OK');

  f=await fixture(browser);p=f.page;f.state.peopleFail=true;f.state.healthFail=true;
  await p.goto(base+'/#discover');await p.locator('#connection-status').waitFor();await p.getByRole('heading',{name:'目录暂时无法加载'}).waitFor();
  f.state.peopleFail=false;f.state.healthFail=false;await p.locator('#connection-retry').click();await p.locator('.card').first().waitFor();assert.deepEqual(f.errors,[]);await f.context.close();console.log('TRIAL_INITIAL_CATALOG_FAILURE_RECOVERY_OK');

  f=await fixture(browser);p=f.page;await p.goto(base+'/#discover');await p.locator('.card').first().waitFor();f.state.searchMode='fail';
  await p.locator('#search').fill('黄仁勋');await p.locator('#search-form button').click();await p.getByRole('heading',{name:'搜索暂时无法完成'}).waitFor();
  f.state.searchMode='ok';await p.locator('[data-retry-search]').click();await p.locator('.card').first().waitFor();
  await p.evaluate(()=>window.TingshuiConnection.check());await p.locator('.card').first().waitFor();f.state.searchMode='hang';await p.locator('#search').fill('Jensen');await p.locator('#search-form button').click();
  await p.getByRole('heading',{name:'搜索暂时无法完成'}).waitFor({timeout:20000});assert((await p.locator('#content').textContent()).includes('请求超时'));
  await p.screenshot({path:'artifacts/visual/trial-search-timeout.png',fullPage:true});f.state.searchMode='ok';await p.locator('[data-retry-search]').click();await p.locator('.card').first().waitFor();assert.deepEqual(f.errors,[]);await f.context.close();console.log('TRIAL_SEARCH_ERROR_TIMEOUT_RETRY_OK');

  f=await fixture(browser);p=f.page;f.state.audioFail=true;await p.goto(base+'/#person/jensen');await p.locator('[data-play=trial-a]').click();await p.locator('#retry-audio').waitFor();
  f.state.audioFail=false;await p.locator('#retry-audio').click();await p.waitForFunction(()=>document.querySelector('audio').currentTime>.2);
  await p.locator('#toggle').click();f.state.audioHang=true;await p.locator('[data-play=trial-b]').click();await p.locator('#retry-audio').waitFor({timeout:16000});
  assert((await p.locator('#audio-state').textContent()).includes('加载较慢'));await p.screenshot({path:'artifacts/visual/trial-media-stall.png',fullPage:true});
  f.state.audioHang=false;await p.locator('#retry-audio').click();await p.waitForFunction(()=>document.querySelector('audio').currentTime>.2);assert.deepEqual(f.errors,[]);await f.context.close();console.log('TRIAL_MEDIA_FAILURE_STALL_RETRY_OK');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
