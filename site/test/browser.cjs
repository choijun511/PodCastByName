const {chromium}=require('/Users/bytedance/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const base='http://127.0.0.1:18767',browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.locator('.discovery-guide').waitFor();
 assert.equal(await page.locator('.card').count(),3);
 await page.locator('#search').fill('Jensen Huang');await page.locator('#search-form button').click();await page.getByRole('heading',{name:'找到你想听的人',exact:true}).waitFor();await page.getByRole('link',{name:'查看出场 →'}).click();
 await page.locator('#explore-lang').waitFor();assert.deepEqual(await page.locator('#explore-lang option').allTextContents(),['全部语言','英语']);
 await page.locator('[data-follow=jensen]').click();await page.getByRole('button',{name:'✓ 已关注',exact:true}).waitFor();
 await page.locator('[data-play=jensen-1]').click();await page.waitForFunction(()=>document.querySelector('audio').currentTime>0,null,{timeout:30000});
 await page.locator('#forward').click();await page.locator('[data-nav=library]').click();await page.getByRole('heading',{name:'留一点时间，听听他们'}).waitFor();assert(await page.locator('audio').evaluate(a=>!a.paused));await page.locator('#toggle').click();const progress=await page.locator('audio').evaluate(a=>a.currentTime);
 await page.reload();await page.waitForFunction(()=>document.querySelector('audio').readyState>=1);assert(Math.abs(await page.locator('audio').evaluate(a=>a.currentTime)-progress)<1);
 await page.goto(base+'/#person/liu');await page.locator('[data-play]').first().click();await page.waitForFunction(()=>document.querySelector('audio').currentTime>0,null,{timeout:30000});await page.locator('#toggle').click();
 await page.locator('#search').fill('线上部署隔离验收');await page.locator('#search-form button').click();await page.locator('#request-name').waitFor();await page.locator('#identity-hint').fill('仅写入本地D1模拟器');await page.locator('#request-form button').click();await page.getByRole('heading',{name:'我的补录请求'}).waitFor();await page.reload();await page.getByRole('heading',{name:'线上部署隔离验收'}).waitFor();
 const other=await browser.newPage();await other.goto(base+'/#requests');await other.getByRole('heading',{name:'还没有补录请求'}).waitFor();await other.close();
 await page.setViewportSize({width:390,height:844});await page.goto(base+'/#person/jensen');await page.locator('#explore-show').waitFor();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:'../artifacts/visual/online-worker-person-mobile.png'});
 assert.equal((await page.request.get(base+'/api/admin/state')).status(),404);assert.equal((await page.request.get(base+'/admin.html')).status(),404);assert.equal((await page.request.get(base+'/data.js')).status(),404);
 assert.deepEqual(errors,[]);console.log('WORKER_D1_BROWSER_OK: search/follow/real EN+ZH playback/progress/request persistence+isolation/mobile/private surfaces');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
