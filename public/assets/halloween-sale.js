// Halloween 2026 sale: 20% off everything, code KuroHalloweenLab (auto-applied on Gumroad).
// Shows a banner and "20% OFF" badges, and removes itself after the end date.
// To remove for good: delete this file and its <script> line in site/build-site.cjs, then rebuild.
(()=>{
const END=Date.UTC(2026,10,2,2,24); // Nov 1 2026 18:24 PST = same moment the Gumroad discount ends
const START=Date.UTC(2026,9,27,0,0);
const now=Date.now();
if(now>=END||now<START)return;
const root=document.getElementById('kl-techno');if(!root)return;
const css=document.createElement('style');
css.textContent=
'#kl-techno .kl-sale-bar{display:block;text-align:center;padding:10px 5%;background:linear-gradient(90deg,#1d0b36,#6d3fd1 50%,#1d0b36);color:#fff;font:500 12px "IBM Plex Mono",monospace;letter-spacing:1.5px;text-transform:uppercase;text-decoration:none;position:relative;z-index:30}'+
'#kl-techno .kl-sale-bar:hover{filter:brightness(1.12)}'+
'#kl-techno .kl-sale-bar b{font-weight:600}'+
'#kl-techno .kl-sale-badge{display:inline-block;margin-left:10px;padding:3px 8px;background:#8b5cf6;color:#fff;font:600 10px "IBM Plex Mono",monospace;letter-spacing:1px;vertical-align:middle;border-radius:2px}'+
'#kl-techno .kl-sale-old{color:#8a8590;text-decoration:line-through;font-size:.7em;margin-right:8px}'+
'#kl-techno .kl-tile.kl-on-sale .kl-shot{position:relative}'+
'#kl-techno .kl-sale-corner{position:absolute;top:14px;right:14px;z-index:3;padding:5px 10px;background:#8b5cf6;color:#fff;font:600 11px "IBM Plex Mono",monospace;letter-spacing:1px;border-radius:2px;box-shadow:0 4px 14px #0008;pointer-events:none}'+
'@media(max-width:600px){#kl-techno .kl-sale-bar{font-size:10.5px;letter-spacing:1px;padding:9px 4%}}';
document.head.appendChild(css);

// 1) Banner across the top of every page, linking to the shop.
const bar=document.createElement('a');
bar.className='kl-sale-bar';bar.href='/shop/';
bar.innerHTML='🎃 Halloween sale: <b>20% off everything</b> until Nov 1 · code <b>KuroHalloweenLab</b> →';
root.insertBefore(bar,root.firstChild);

// 2) Price handling: "$10" -> "$10" struck through + "$8", with a 20% OFF badge.
const sale=el=>{
 const m=el.textContent.trim().match(/^([^\d]*)(\d+(?:[.,]\d+)?)(.*)$/);if(!m)return false;
 const n=parseFloat(m[2].replace(',','.'));if(!(n>0))return false;
 const off=(Math.round(n*0.8*100)/100).toString().replace('.',m[2].includes(',')?',':'.');
 el.innerHTML='';
 const o=document.createElement('span');o.className='kl-sale-old';o.textContent=m[1]+m[2]+m[3];
 el.appendChild(o);el.appendChild(document.createTextNode(m[1]+off+m[3]));
 return true;
};
// Shop and home tiles
root.querySelectorAll('.kl-tile').forEach(t=>{
 const p=t.querySelector('.kl-price');if(!p||!/\d/.test(p.textContent)||!sale(p))return;
 t.classList.add('kl-on-sale');
 const shot=t.querySelector('.kl-shot');
 if(shot&&shot.parentNode===t){const w=document.createElement('div');w.style.position='relative';t.insertBefore(w,shot);w.appendChild(shot);const c=document.createElement('span');c.className='kl-sale-corner';c.textContent='20% OFF';w.appendChild(c);}
});
// Product detail pages
root.querySelectorAll('.kl-detail-page .kl-price').forEach(p=>{
 if(p.closest('.kl-tile')||!sale(p))return;
 const b=document.createElement('span');b.className='kl-sale-badge';b.textContent='20% OFF';p.appendChild(b);
});
})();
