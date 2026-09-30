/* Person-first exploration. All descriptions derive from the current catalog. */
(()=>{
  'use strict';
  const defaults={show:'',lang:'',listened:'',year:'',sort:'newest'};
  const status=(e,saved)=>saved.completed?.[e.id]?'finished':Number(saved.progress?.[e.id]||0)>5?'started':'unheard';
  const dateValue=e=>{const value=Date.parse(e.date);return Number.isFinite(value)?value:null;};
  const yearOf=e=>dateValue(e)===null?'':String(new Date(dateValue(e)).getUTCFullYear());
  const showOf=(p,e)=>e.show||p.show||'节目未标注';
  function languageLabel(value){
    const label=String(value||'').trim();
    if(/^(en(?:[-_][a-z]+)*|english|英语)$/i.test(label))return '英语';
    if(/^(zh(?:[-_][a-z]+)*|chinese|中文)$/i.test(label))return '中文';
    return label||'语言未标注';
  }
  function readPersonFilters(){
    const params=new URLSearchParams(location.hash.split('?')[1]||'');
    const values={...defaults};
    for(const key of Object.keys(defaults))if(params.has(key))values[key]=params.get(key);
    if(!['','unheard','started','finished'].includes(values.listened))values.listened='';
    if(!['newest','oldest'].includes(values.sort))values.sort='newest';
    if(values.lang)values.lang=languageLabel(values.lang);
    return values;
  }
  function selectEpisodes(p,saved,filters){
    return p.episodes.filter(e=>(!filters.show||showOf(p,e)===filters.show)&&(!filters.lang||languageLabel(e.lang)===languageLabel(filters.lang))&&(!filters.year||yearOf(e)===filters.year)&&(!filters.listened||status(e,saved)===filters.listened)).slice().sort((a,b)=>{
      const av=dateValue(a),bv=dateValue(b);
      if(av===null)return bv===null?0:1;if(bv===null)return -1;
      return filters.sort==='oldest'?av-bv:bv-av;
    });
  }
  function person(p,saved,{esc,ep}){
    const filters=readPersonFilters(),episodes=selectEpisodes(p,saved,filters);
    const unique=values=>[...new Set(values)].sort((a,b)=>a.localeCompare(b,'zh-CN'));
    function select(key,label,choices){
      const list=choices.slice();
      if(filters[key]&&!list.some(([value])=>value===filters[key]))list.push([filters[key],filters[key]+'（当前无内容）']);
      return `<label for="explore-${key}">${label}<select id="explore-${key}" data-explore-filter="${key}">${list.map(([value,text])=>`<option value="${esc(value)}" ${value===filters[key]?'selected':''}>${esc(text)}</option>`).join('')}</select></label>`;
    }
    const reset=`#person/${encodeURIComponent(p.id)}`;
    let lastYear='';
    const rows=episodes.map(e=>{
      const year=yearOf(e)||'日期未标注',heading=year!==lastYear?`<h3 class="appearance-year">${esc(year)}</h3>`:'';lastYear=year;
      const label={finished:'已听完',started:'收听中',unheard:'未听'}[status(e,saved)];
      return `${heading}<div class="appearance-entry" data-appearance-id="${esc(e.id)}"><div class="appearance-status">${label}<span>${esc(e.version||'音频版本未标注')}</span></div>${ep(p,e)}</div>`;
    }).join('');
    return `<section class="appearance-browser" aria-labelledby="appearance-heading"><div class="section-head"><h2 id="appearance-heading">出场时间线</h2><small>${p.episodes.length} 个已收录音频版本</small></div><p class="explore-note">按节目发布日期排列。剪辑版与完整版分别展示，音频版本数不等于独立出场次数；每条内容均可查看本人参与依据。</p><div class="appearance-filters" aria-label="筛选人物出场">${select('show','节目',[['','全部节目'],...unique(p.episodes.map(e=>showOf(p,e))).map(x=>[x,x])])}${select('lang','语言',[['','全部语言'],...unique(p.episodes.map(e=>languageLabel(e.lang))).map(x=>[x,x])])}${select('listened','收听状态',[['','全部状态'],['unheard','未听'],['started','收听中'],['finished','已听完']])}${select('year','发布年份',[['','全部年份'],...unique(p.episodes.map(yearOf).filter(Boolean)).reverse().map(x=>[x,x+' 年'])])}${select('sort','排列顺序',[['newest','最新在前'],['oldest','最早在前']])}</div><div class="appearance-results"><p role="status">显示 ${episodes.length} / ${p.episodes.length} 个音频版本</p><a href="${reset}" data-explore-reset>重置筛选</a></div>${episodes.length?`<div class="appearance-timeline">${rows}</div>`:`<div class="empty"><h3>这个条件下，还没有出场</h3><p>试试其他节目、语言或收听状态。</p><a href="${reset}" data-explore-reset>查看全部出场 →</a></div>`}</section>`;
  }
  function reason(p,saved={},people=[]){
    if(saved.following?.includes(p.id))return '已在你的关注阵容 · 查看已收录出场';
    const peers=people.filter(x=>x.id!==p.id&&saved.following?.includes(x.id)&&x.topic&&x.topic===p.topic);
    if(peers.length)return `与你关注的${peers[0].name}同属「${p.topic}」领域`;
    return p.topic?`探索「${p.topic}」领域 · ${p.role||'从本人对谈开始'}`:(p.role||'从本人对谈认识这个人');
  }
  function discovery(people,saved,{esc}){
    const episodes=people.flatMap(p=>p.episodes),topics=[...new Set(people.map(p=>p.topic).filter(Boolean))];
    const followedTopics=new Set(people.filter(p=>saved.following?.includes(p.id)).map(p=>p.topic));
    return `<section class="discovery-guide" aria-labelledby="discovery-guide-heading"><div class="discovery-guide-title"><span class="eyebrow">FIND YOUR NEXT VOICE</span><h2 id="discovery-guide-heading">从好奇的领域开始</h2><p>先认识一个人，再走进他的声音现场。</p></div><div class="discovery-entries">${topics.map(topic=>`<button data-filter="${esc(topic)}" class="discovery-entry"><strong>${esc(topic)} <span aria-hidden="true">↗</span></strong><span>${followedTopics.has(topic)?'你已关注的领域':'按目录领域探索'} · ${people.filter(p=>p.topic===topic).length} 位人物</span></button>`).join('')||'<p class="explore-note">目录暂时没有可探索的人物。</p>'}</div><div class="catalog-coverage"><b>${people.length} 位人物 / ${episodes.length} 个音频版本</b><p>当前为精选样本，尚未覆盖全网。发现入口依据人物领域与本设备关注记录，不代表热度排名。支持播放的公开 RSS 样本，不等于已接入各平台完整目录。</p><a href="#search?q=">搜索其他人物 →</a></div></section>`;
  }
  const bound=new WeakSet();
  function bind(container){
    if(bound.has(container))return;bound.add(container);
    container.addEventListener('change',event=>{
      const control=event.target.closest('[data-explore-filter]');if(!control)return;
      const [path,query='']=location.hash.split('?');
      if(!path.startsWith('#person/'))return;
      const params=new URLSearchParams(query),key=control.dataset.exploreFilter;
      if(control.value===defaults[key])params.delete(key);else params.set(key,control.value);
      location.hash=path+(params.size?'?'+params.toString():'');
    });
  }
  window.TingshuiExplore={person,discovery,reason,readPersonFilters,bind,selectEpisodes,languageLabel};
})();
