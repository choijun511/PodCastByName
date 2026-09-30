const {chromium}=require('/Users/bytedance/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
const page=await browser.newPage({viewport:{width:1440,height:1050}}),base=process.env.TEST_BASE||'http://127.0.0.1:18768',errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(base+'/admin.html');assert.equal((await page.request.get(base+'/api/admin/state')).status(),401);
await page.getByLabel('管理凭据',{exact:true}).fill('wrong');await page.getByRole('button',{name:'进入后台'}).click();await page.getByRole('status').filter({hasText:'管理凭据无效'}).waitFor();
await page.getByLabel('管理凭据',{exact:true}).fill('local-test-only-'.repeat(4));await page.getByRole('button',{name:'进入后台'}).click();await page.locator('#workspace').waitFor({state:'visible'});
await page.locator('[data-tab="validation"]').click();await page.getByRole('button',{name:'运行规则回归测试'}).click();await page.locator('#evaluations').getByText(/合成回归 12\/12/).first().waitFor();
await page.locator('[data-tab="sources"]').click();await page.locator('[data-run="tianzhen"]').click();await page.getByRole('status').filter({hasText:'运行完成'}).waitFor({timeout:110000});
await page.locator('[data-run="tianzhen"]').click();await page.getByRole('status').filter({hasText:/缓存复用 [1-9]/}).waitFor({timeout:110000});
await page.locator('[data-tab="candidates"]').click();await page.locator('[data-evidence]').first().click();await page.getByRole('dialog').waitFor();assert((await page.locator('#evidenceBody').innerText()).includes('刘震云'));await page.getByRole('button',{name:'关闭证据档案'}).click();
await page.screenshot({path:'/tmp/tingshui-intake-desktop.png',fullPage:true});
await page.setViewportSize({width:375,height:812});await page.screenshot({path:'/tmp/tingshui-intake-mobile.png',fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
await page.getByRole('button',{name:'退出后台'}).click();await page.locator('#login').waitFor({state:'visible'});assert.equal(await page.locator('#candidateList').innerText(),'');assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(x=>/token|admin/i.test(x))),false);assert.deepEqual(errors,[]);
console.log('PASS: unauthorized, login error/success, persisted regression, real RSS run/cache, evidence, mobile overflow, logout privacy.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
