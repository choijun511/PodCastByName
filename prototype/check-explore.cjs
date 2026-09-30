// Pure catalog/filter tests; the integrated browser workflow is checked separately.
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const ctx={window:{},location:{hash:'#person/a'},URLSearchParams};
vm.runInNewContext(fs.readFileSync(__dirname+'/dist/explore.js','utf8'),ctx);
const api=ctx.window.TingshuiExplore;
const p={id:'a',topic:'科技',role:'工程师',episodes:[
{id:'old',show:'节目甲',date:'2022-04-01',lang:'中文',version:'完整版'},
{id:'new',show:'节目乙',date:'2024-01-02',lang:'English',version:'剪辑版'},
{id:'unknown',show:'节目甲',date:'unknown',lang:'中文'},
{id:'same',show:'节目乙',date:'2024-01-02',lang:'English',version:'完整版'}]};
const saved={completed:{old:true},progress:{new:60},following:['b']};
const ids=filters=>Array.from(api.selectEpisodes(p,saved,{...api.readPersonFilters(),...filters}),e=>e.id);
assert.deepEqual(ids({}),['new','same','old','unknown']);
assert.deepEqual(ids({sort:'oldest'}),['old','new','same','unknown']);
assert.deepEqual(ids({listened:'unheard'}),['same','unknown']);
assert.deepEqual(ids({listened:'started'}),['new']);
assert.deepEqual(ids({listened:'finished'}),['old']);
assert.deepEqual(ids({show:'节目乙',lang:'中文'}),[]);
assert.deepEqual(ids({year:'2024'}),['new','same']);
ctx.location.hash='#person/a?show='+encodeURIComponent('节目乙')+'&listened=started';
assert.deepEqual(ids({}),['new']);
ctx.location.hash='#person/a?show=missing';
const esc=s=>String(s).replace(/[<>&"']/g,'_');
const html=api.person(p,saved,{esc,ep:(_p,e)=>'<article>'+e.id+'</article>'});
assert.match(html,/这个条件下，还没有出场/);
assert.match(html,/data-explore-reset/);
assert.match(html,/missing（当前无内容）/);
assert.match(api.reason(p,saved,[{id:'b',name:'某嘉宾',topic:'科技'}]),/与你关注的某嘉宾/);
assert.match(api.discovery([p],saved,{esc}),/1 位人物 \/ 4 个音频版本/);
console.log('explore: date ordering, missing dates, independent versions, combined filters, URL restoration, empty reset, recommendation provenance passed');

for(const value of ['en','en-US','en-GB','English','英语'])assert.equal(api.languageLabel(value),'英语');
for(const value of ['zh','zh-CN','zh-TW','中文','Chinese'])assert.equal(api.languageLabel(value),'中文');
assert.equal(api.languageLabel('fr'),'fr');
assert.equal(api.languageLabel(''),'语言未标注');
const mixed={...p,episodes:p.episodes.map((e,i)=>({...e,lang:['zh-CN','en','Chinese','English'][i]}))};
ctx.location.hash='#person/a?lang=en-US';
assert.equal(api.readPersonFilters().lang,'英语');
assert.deepEqual(Array.from(api.selectEpisodes(mixed,saved,api.readPersonFilters()),e=>e.id),['new','same']);
assert.deepEqual(Array.from(api.selectEpisodes(mixed,saved,{lang:'zh-TW'}),e=>e.id),['old','unknown']);
const languageHTML=api.person(mixed,saved,{esc,ep:()=>''});
assert.equal((languageHTML.match(/value="英语"/g)||[]).length,1);
assert.equal((languageHTML.match(/value="中文"/g)||[]).length,1);
assert.match(languageHTML,/value="英语" selected/);
console.log('language aliases: normalized options, legacy URL values, Chinese and English group matching passed');
