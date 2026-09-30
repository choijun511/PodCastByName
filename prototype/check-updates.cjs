const {chromium}=require('/Users/bytedance/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('fs'),assert=require('assert');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),base='http://127.0.0.1:18765',errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const headers={Authorization:'Bearer '+fs.readFileSync('/tmp/tingshui-admin-token','utf8').trim()};
 const state=await (await page.request.get(base+'/api/admin/state',{headers})).json();
 const candidates=state.candidates.filter(c=>c.guid==='updates-fixture');assert.equal(candidates.length,2);
 async function review(c,status){const r=await page.request.post(base+'/api/admin/review',{headers,data:{id:c.id,status,evidence:'Isolated automated test fixture only'}});assert(r.ok());}
 await page.goto(base+'/#person/jensen');await page.locator('[data-follow="jensen"]').click();await page.getByRole('button',{name:'✓ 已关注',exact:true}).waitFor();
 await page.goto(base+'/#person/liu');await page.locator('[data-follow="liu"]').click();await page.getByRole('button',{name:'✓ 已关注',exact:true}).waitFor();
 await page.goto(base+'/#following');await page.getByRole('heading',{name:'等待下一场对谈'}).waitFor();
 for(const c of candidates)await review(c,'approved');
 await page.getByRole('button',{name:'刷新更新 ↻'}).click();await page.locator('.update-card').waitFor();assert.equal(await page.locator('.update-card').count(),1);await page.locator('.update-tag').filter({hasText:'历史补录'}).waitFor();
 const heading=await page.locator('.update-heading').innerText();assert(heading.includes('黄仁勋')&&heading.includes('刘震云'));assert.equal(await page.locator('.update-card.unread').count(),1);
 await page.screenshot({path:'artifacts/visual/following-updates-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'标为已读'}).click();await page.locator('.update-heading').getByText('已读',{exact:true}).waitFor();await page.reload();await page.locator('.update-heading').getByText('已读',{exact:true}).waitFor();
 for(const c of candidates)await review(c,'rejected');await page.getByRole('button',{name:'刷新更新 ↻'}).click();await page.getByRole('heading',{name:'等待下一场对谈'}).waitFor();
 for(const c of candidates)await review(c,'approved');await page.getByRole('button',{name:'刷新更新 ↻'}).click();await page.locator('.update-heading').getByText('已读',{exact:true}).waitFor();assert.equal(await page.locator('.update-card').count(),1);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/visual/following-updates-mobile.png',fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.route('**/api/updates?**',route=>route.fulfill({status:503,body:'{}'}));await page.getByRole('button',{name:'刷新更新 ↻'}).click();await page.getByRole('heading',{name:'暂时无法读取更新'}).waitFor();await page.unroute('**/api/updates?**');await page.getByRole('button',{name:'重试更新'}).click();await page.locator('.update-card').waitFor();
 // Older devices establish a baseline instead of receiving all historical entries.
 const old=await browser.newPage();await old.addInitScript(()=>localStorage.setItem('tingshui-v1',JSON.stringify({following:['jensen'],queue:[],progress:{},last:null})));await old.goto(base+'/#following');await old.getByRole('heading',{name:'等待下一场对谈'}).waitFor();
 assert.deepEqual(errors,[]);console.log('FOLLOW_BASELINE_GROUPING_BACKFILL_READ_REVOKE_REAPPROVE_RETRY_MIGRATION_OK');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
