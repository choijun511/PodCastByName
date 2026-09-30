/* Local preview health and bounded API requests; listening state is untouched. */
(()=>{
  const banner=document.querySelector('#connection-status');
  const message=document.querySelector('#connection-message');
  const retry=document.querySelector('#connection-retry');
  let state='unknown',checking=null;
  function unavailable(text){state='down';banner.hidden=false;message.textContent=text;}
  async function request(url,options={}){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await window.fetch(url,{...options,signal:controller.signal});
      if(response.status>=500)unavailable('服务暂不可用。收听记录仍保存在此设备，可稍后重连。');
      return response;
    }catch(error){
      unavailable(error.name==='AbortError'?'连接超时，请检查网络后重试。':'网络连接已断开，请检查网络后重新连接。');
      throw new Error(error.name==='AbortError'?'请求超时，请重试':'无法连接服务，请检查网络后重试');
    }finally{clearTimeout(timer);}
  }
  async function check(manual=false){
    if(checking)return checking;
    checking=(async()=>{
      retry.disabled=true;
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4000);
      try{
        const r=await window.fetch('/api/health',{signal:controller.signal,cache:'no-store'});
        const data=await r.json();
        if(!r.ok||data.service!=='tingshui'||data.status!=='ok')throw Error('health');
        const recovered=state==='down';state='up';banner.hidden=true;
        if(recovered||manual)window.dispatchEvent(new CustomEvent('tingshui:reconnect'));
      }catch(error){unavailable('暂时无法连接服务，请稍后点击重新连接。');}
      finally{clearTimeout(timer);retry.disabled=false;checking=null;}
    })();
    return checking;
  }
  retry.addEventListener('click',()=>check(true));
  window.addEventListener('online',()=>check());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)check();});
  setInterval(()=>{if(!document.hidden)check();},15000);
  window.TingshuiConnection={request,check};
  check();
})();
