const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),publicDir=path.join(root,'public');
const input=process.argv[2]?path.resolve(process.argv[2]):publicDir;
const read=(p)=>JSON.parse(fs.readFileSync(path.join(input,p),'utf8').replace(/^\uFEFF/,''));
const data={products:read('shop/products.json').products,projects:read('projects/projects.json').projects,games:read('games/games.json').games,images:{}};
for(const p of [...data.products,...data.projects])if(p.img)data.images[p.img.split('/').pop()]=p.img;
data.images['emblem.webp']='/assets/img/emblem.webp';
const {pages}=require('./pages.cjs')(data);
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const routes={home:'/',about:'/about/',games:'/games/',projects:'/projects/',shop:'/shop/',commissions:'/commissions/',contact:'/contact/'};
const links=(html)=>html.replace(/<button\b([^>]*)>([\s\S]*?)<\/button>/g,(all,attrs,label)=>{
 let m=attrs.match(/data-page="([^"]+)"/),href;
 if(m)href=routes[m[1]];
 else if(m=attrs.match(/data-product="(\d+)"/))href='/shop/'+data.products[+m[1]].slug+'/';
 else if(m=attrs.match(/data-project="(\d+)"/))href='/projects/'+data.projects[+m[1]].slug+'/';
 if(!href)return all;
 return `<a${attrs.replace(/ data-(page|product|project)="[^"]*"/g,'')} href="${href}">${label}</a>`;
}).replace(/<div id="kl-(product|project)-detail"><\/div>/g,'').replace(/href="https:\/\/kurolabs.net(\/[^" ]*)"/g,'href="$1"').replace(/(<img\b[^>]*)(>)/g,'$1 decoding="async"$2');
const nav=active=>Object.entries(routes).map(([key,url])=>`<a href="${url}"${active===key?' aria-current="page"':''}>${key[0].toUpperCase()+key.slice(1)}</a>`).join('');
function documentHtml(title,description,url,active,body){return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)} — Kuro Labs</title><meta name="description" content="${e(description)}"><link rel="canonical" href="https://kurolabs.net${url}"><meta name="theme-color" content="#08090b"><link rel="icon" href="/favicon.ico"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&amp;family=IBM+Plex+Mono:wght@400;500&amp;display=swap"><link rel="stylesheet" href="/assets/techno.css?v=20260921"><script src="/assets/site.js?v=20260921" defer></script></head>
<body><div id="kl-techno"><a class="kl-skip" href="#kl-view">Skip to content</a><header class="kl-header"><a class="kl-brand" href="/" aria-label="Kuro Labs home"><img src="/assets/img/emblem.webp" width="28" height="39" alt="">KURO<span class="kl-red">/</span>LABS</a><button class="kl-menu-toggle" type="button" aria-expanded="false" aria-controls="kl-site-menu">Menu +</button><nav id="kl-site-menu" class="kl-nav" aria-label="Main navigation">${nav(active)}</nav></header>
<main id="kl-view">${links(body)}</main>
<footer class="kl-footer"><div><strong>KURO<span class="kl-red">/</span>LABS</strong><p class="kl-mono">Independent ideas. Built into reality.</p></div><nav aria-label="Footer"><a href="/games/">Games</a><a href="/shop/">Shop</a><a href="/commissions/">Work with me ↗</a></nav><span class="kl-mono">© ${new Date().getFullYear()} KURO LABS</span></footer></div></body></html>`;}
const written=[];
function write(rel,html){const f=path.join(publicDir,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,html);written.push('public/'+rel);}
const descriptions={home:'Custom software, local AI, 3D and VR assets, websites and browser games by Jiří Fikejs.',about:'Meet Jiří, also known as Kuro, the independent developer behind Kuro Labs.',games:'Browser games from Kuro Labs: Mytheder and projects in development.',projects:'Explore Kuro Labs projects: local AI, creative pipelines and multiplayer games.',shop:'VRChat props and decor. Check product compatibility and buy through Gumroad.',commissions:'Custom software, AI systems, 3D assets, websites and games. Request a project quote.',contact:'Contact Kuro for commissions, asset support and project enquiries.'};
for(const [key,url] of Object.entries(routes))write((key==='home'?'':key+'/')+'index.html',documentHtml(key==='home'?'Exploring the unknown':key[0].toUpperCase()+key.slice(1),descriptions[key],url,key,pages[key]()));
const back=(section,name)=>`<div class="kl-detail-top"><a class="kl-action" href="/${section}/">← Back to ${section}</a><span class="kl-mono">${section.toUpperCase()} / ${e(name)}</span></div>`;
const link=(url,label)=>url?`<a class="kl-action" href="${e(url)}"${/^https?:/.test(url)?' target="_blank" rel="noopener noreferrer"':''}>${e(label)} ↗</a>`:'';
const specs=rows=>`<dl class="kl-specs">${rows.map(s=>`<div><dt>${e(s[0])}</dt><dd>${e(s[1])}</dd></div>`).join('')}</dl>`;
for(const p of data.products){
 const media=p.video?`<video class="kl-product-video" controls playsinline preload="metadata" poster="${e(p.img)}" aria-label="${e(p.name)} showcase"><source src="${e(p.video)}" type="video/mp4">${link(p.video,'Download showcase video')}</video>`:`<img src="${e(p.img)}" alt="${e(p.name)}">`;
 const body=`<div class="kl-wrap kl-detail-page">${back('shop',p.name)}<article><div class="kl-detail-layout">${media}<div><span class="kl-tag">${e(p.specs[0][1])}</span><h1>${e(p.name)}</h1><p>${e(p.short)}</p><div class="kl-price">${e(p.price)}</div><div class="kl-actions">${link(p.buy,'Buy on Gumroad')}${link(p.buy2,'Buy on Jinxxy')}</div><p class="kl-buy-note">One-time purchase · Checkout opens on Gumroad.</p></div></div><div class="kl-project-body"><h2>About this asset</h2><p style="margin-top:18px">${e(p.long)}</p>${specs(p.specs)}</div></article></div>`;
 write('shop/'+p.slug+'/index.html',documentHtml(p.name,p.short,'/shop/'+p.slug+'/','shop',body));
}
for(const p of data.projects){
 const d=p.detail||{},shot=p.img?`<img src="${e(p.img)}" alt="${e(p.name)}">`:'<div class="kl-game-art">IN DEVELOPMENT</div>';
 const body=`<div class="kl-wrap kl-detail-page">${back('projects',p.name)}<article><div class="kl-detail-layout">${shot}<div><span class="kl-tag">${e(p.status)}</span><h1>${e(p.name)}</h1><p>${e(p.what)}</p><p class="kl-mono">${e((p.stack||[]).join(' / '))}</p><div class="kl-actions">${link(p.repo,'View repository')}${link(p.link,'Open '+p.name)}</div></div></div><div class="kl-project-body">${d.intro?`<p>${e(d.intro)}</p>`:''}${(d.sections||[]).map(s=>`<section class="kl-section"><h2>${e(s.h)}</h2><p style="margin-top:18px">${s.p||''}</p>${s.bullets?`<ul>${s.bullets.map(b=>`<li>${b}</li>`).join('')}</ul>`:''}</section>`).join('')}${d.facts?specs(d.facts):''}${(d.shots||[]).map(s=>`<figure><img class="kl-shot" src="${e(s.src)}" alt="${e(s.cap)}" loading="lazy"><figcaption>${e(s.cap)}</figcaption></figure>`).join('')}</div></article></div>`;
 write('projects/'+p.slug+'/index.html',documentHtml(p.name,p.what,'/projects/'+p.slug+'/','projects',body));
}
write('404.html',documentHtml('Page not found','This page could not be found.','/404.html','',`<div class="kl-wrap"><div class="kl-page-head"><div class="kl-eye">Nothing here / 404</div><h1>Lost in the lab?</h1><p>This page doesn’t exist, or it has moved.</p><div class="kl-actions"><a class="kl-action kl-primary" href="/">Back to home</a><a class="kl-action" href="/games/">Explore games</a></div></div></div>`));
fs.writeFileSync(path.join(root,'site/generated-files.json'),JSON.stringify(written,null,2)+'\n');
console.log(`Generated ${written.length} pages.`);
