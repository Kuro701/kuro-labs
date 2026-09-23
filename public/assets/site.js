(()=>{
const root=document.getElementById('kl-techno');if(!root)return;
root.classList.add('kl-enhanced');
const menu=root.querySelector('.kl-menu-toggle'),nav=root.querySelector('.kl-nav');
function close(){nav.classList.remove('kl-open');menu.setAttribute('aria-expanded','false');menu.textContent='Menu +';}
menu.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';nav.classList.toggle('kl-open',open);menu.setAttribute('aria-expanded',String(open));menu.textContent=open?'Close −':'Menu +';});
root.addEventListener('keydown',e=>{if(e.key==='Escape'&&nav.classList.contains('kl-open')){close();menu.focus();}});
// Keep existing shared project and product query links working.
const slug=new URLSearchParams(location.search).get('p');
if(slug&&/^\/(projects|shop)\/?$/.test(location.pathname)){
 const prefix=location.pathname.replace(/\/$/,'')+'/';
 const target=[...document.querySelectorAll('main a[href]')].find(a=>a.getAttribute('href')===prefix+slug+'/');
 if(target)location.replace(target.href);
}
// Real Gumroad sales counts on the shop listing. Fails silently — the
// page works fine with no counter if the endpoint is ever unreachable.
const soldEls=root.querySelectorAll('[data-sold-slug]');
if(soldEls.length)fetch('/api/sales-count').then(r=>r.ok?r.json():null).then(data=>{
 if(!data||!data.ok)return;
 soldEls.forEach(el=>{
  const n=data.counts[el.getAttribute('data-sold-slug').toLowerCase()];
  if(typeof n==='number'){el.textContent=(n===1?'1 sold':n+' sold');el.hidden=false;}
 });
}).catch(()=>{});
})();
