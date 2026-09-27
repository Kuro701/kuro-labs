/* Kuro Labs living K: pixel-swarm morph (WebGL). Static K if reduced-motion / Save-Data / no WebGL. */
(()=>{
const COLS=180,ROWS=262,DUR=2600,HOLD_K=4200,HOLD_S=2600;
const stage=document.querySelector('.kl-art .kl-k');if(!stage)return;
const img=stage.querySelector('img'),cv=stage.querySelector('canvas'),label=document.querySelector('.kl-art-label');
/* HD artwork layers (K-style engraved icons), lazy-loaded after idle */
const HQ_V='?v=20260931',HQ={frame:'/assets/img/k-frame.webp'+HQ_V,shapes:[null,1,2,3,4].map(i=>i&&'/assets/img/k-shape-'+i+'.webp'+HQ_V)};
const mk=(cls,css)=>{const e=document.createElement('img');e.alt='';e.setAttribute('aria-hidden','true');e.decoding='async';e.style.cssText='position:absolute;opacity:0;pointer-events:none;z-index:1;transition:opacity .35s;'+css;stage.insertBefore(e,cv);return e};
const frameEl=mk('f','inset:0;width:100%;height:100%;object-fit:contain;filter:brightness(1.55) drop-shadow(0 0 28px #ed294548)');
const shapeEl=mk('s','left:4.545%;top:18.72%;width:90.909%;height:62.402%;object-fit:contain;filter:brightness(1.55)');
cv.style.zIndex=2;
function loadImgs(){const load=u=>new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=u});return Promise.all([load(HQ.frame),...HQ.shapes.slice(1).map(load)]).then(r=>{frameEl.src=HQ.frame;shapeImgs=[null,...r.slice(1)]})}
function hq(on,i){if(on){shapeEl.src=HQ.shapes[i];requestAnimationFrame(()=>{shapeEl.style.opacity=1;cv.style.transition='opacity .4s';cv.style.opacity=0});return}
 shapeEl.style.opacity=0}
const LABEL0=label?label.textContent:'';
const hud={};
if(matchMedia('(prefers-reduced-motion:reduce)').matches||(navigator.connection&&navigator.connection.saveData))return
const gl=cv.getContext('webgl',{antialias:false,alpha:true,premultipliedAlpha:true});
if(!gl)return

const NAMES=['K','SOFTWARE & AI','3D & VR','WEB DESIGN','BROWSER GAMES'];
const CX=220,CY=320;

/* ---------- sample emblem + shapes into cell lists ---------- */
const off=document.createElement('canvas');off.width=COLS;off.height=ROWS;
const oc=off.getContext('2d',{willReadFrequently:true});
const isGlyph=(X,Y)=>{const dx=X-CX,dy=Y-CY;if(Math.hypot(dx,dy)>192)return false;if(Math.abs(dx)<6&&(Y<215||Y>452))return false;return Y>150&&Y<500};
let forms,nP,shapeImgs=[];
function build(){
 oc.setTransform(1,0,0,1,0,0);oc.clearRect(0,0,COLS,ROWS);oc.imageSmoothingQuality='high';oc.drawImage(img,0,0,COLS,ROWS);
 const d=oc.getImageData(0,0,COLS,ROWS).data,kg=[];
 for(let y=0;y<ROWS;y++)for(let x=0;x<COLS;x++){const i=(y*COLS+x)*4;if(d[i+3]<80)continue;
  if(!isGlyph((x+.5)*440/COLS,(y+.5)*641/ROWS))continue;
  kg.push({x:x+.5,y:y+.5,c:[Math.min(1,d[i]*1.5/255),Math.min(1,d[i+1]*1.9/255),Math.min(1,d[i+2]*1.9/255)]})}
 /* target cells come straight from the HD icon images, so any artwork dropped into /assets/img/k-shape-N.webp is used as-is */
 const shapes=[];
 for(let s=1;s<=4;s++){
  oc.setTransform(1,0,0,1,0,0);oc.clearRect(0,0,COLS,ROWS);
  oc.drawImage(shapeImgs[s],(CX-200)*COLS/440,(CY-200)*ROWS/641,400*COLS/440,400*ROWS/641);
  const dd=oc.getImageData(0,0,COLS,ROWS).data,list=[],ls=[];
  for(let y=0;y<ROWS;y++)for(let x=0;x<COLS;x++){const i=(y*COLS+x)*4;if(dd[i+3]>140){const l=(dd[i]*.3+dd[i+1]*.59+dd[i+2]*.11)/255;list.push({x:x+.5,y:y+.5,l});ls.push(l)}}
  ls.sort((a,b)=>a-b);const p=ls[Math.floor(ls.length*.9)]||.5;list.forEach(o=>o.l=Math.min(1.25,o.l/p*.9));
  shapes.push(list)}
 const Ng=Math.max(kg.length,...shapes.map(s=>s.length));nP=Ng;
 const byPos=(a,b)=>a.y-b.y||a.x-b.x;kg.sort(byPos);shapes.forEach(s=>s.sort(byPos));
 const colors=new Float32Array(nP*3),rnd=new Float32Array(nP*4);
 forms=[...Array(5)].map(()=>({pos:new Float32Array(nP*2),lum:new Float32Array(nP)}));
 for(let k=0;k<Ng;k++){const kc=kg[Math.floor(k*kg.length/Ng)];
  colors.set(kc.c,k*3);rnd.set([Math.random(),Math.random()-.5,Math.random()-.5,1],k*4);
  forms[0].pos[k*2]=kc.x;forms[0].pos[k*2+1]=kc.y;forms[0].lum[k]=1;
  shapes.forEach((s,j)=>{const t=s[Math.floor(k*s.length/Ng)]||kc;forms[j+1].pos[k*2]=t.x;forms[j+1].pos[k*2+1]=t.y;forms[j+1].lum[k]=t.l||1})}
 upload(colors,rnd);
}

/* ---------- WebGL ---------- */
const VS=`attribute vec2 a_s,a_t;attribute float a_ls,a_lt;attribute vec3 a_c;attribute vec4 a_r;
uniform float u_t,u_cell,u_pass,u_sa,u_sb;uniform vec2 u_grid;varying vec3 v_c;
void main(){
 float d=(a_s.x/u_grid.x*.4+a_s.y/u_grid.y*.6)*.4+a_r.x*.16;
 float t=clamp((u_t-d)/.44,0.,1.);
 float e=t<.5?4.*t*t*t:1.-pow(-2.*t+2.,3.)/2.;
 float s=sin(3.14159*t)*a_r.w;
 vec2 p=mix(a_s,a_t,e)+a_r.yz*s*34.;
 p=floor(p)+.5;
 gl_Position=vec4(p.x/u_grid.x*2.-1.,1.-p.y/u_grid.y*2.,0.,1.);
 gl_PointSize=u_cell*(u_pass>.5?5.:1.);
 float fl=a_r.w>.5?s:.22*sin(3.14159*u_t);
 float tl=clamp(dot(a_c,vec3(.34))/.5,0.,1.5);
 float g=a_r.w>.5?1.:0.;
 vec3 cf=(u_sa*g>.5)?vec3(1.,.2,.27)*(.12+.98*a_ls*a_ls)*(.78+.3*tl):a_c;
 vec3 ct=(u_sb*g>.5)?vec3(1.,.2,.27)*(.12+.98*a_lt*a_lt)*(.78+.3*tl):a_c;
 v_c=mix(mix(cf,ct,e),vec3(1.,.4,.5),fl*.6);}`;
const FS=`precision mediump float;uniform float u_fp;varying vec3 v_c;
void main(){vec2 c=gl_PointCoord;
 if(u_fp<.5){if(c.x<.08||c.x>.92||c.y<.08||c.y>.92)discard;gl_FragColor=vec4(v_c,1.);}
 else{float a=1.-length(c-.5)*2.;if(a<=0.)discard;a=a*a*.07;gl_FragColor=vec4(v_c*a,a);}}`;
const sh=(t,s)=>{const o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);if(!gl.getShaderParameter(o,gl.COMPILE_STATUS))throw gl.getShaderInfoLog(o);return o};
const prog=gl.createProgram();gl.attachShader(prog,sh(gl.VERTEX_SHADER,VS));gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,FS));gl.linkProgram(prog);if(!gl.getProgramParameter(prog,gl.LINK_STATUS))throw gl.getProgramInfoLog(prog);gl.useProgram(prog);
const L={};['a_s','a_t','a_ls','a_lt','a_c','a_r'].forEach(n=>L[n]=gl.getAttribLocation(prog,n));
const U={};['u_t','u_cell','u_pass','u_fp','u_grid','u_sa','u_sb'].forEach(n=>U[n]=gl.getUniformLocation(prog,n));
const B={};function buf(data){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);return b}
function upload(colors,rnd){B.c=buf(colors);B.r=buf(rnd);forms.forEach(f=>{f.bp=buf(f.pos);f.bl=buf(f.lum)})}
function attr(loc,b,n){gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,n,gl.FLOAT,false,0,0)}
let A=0,Bf=0;
function bind(a,b){A=a;Bf=b;gl.uniform1f(U.u_sa,a?1:0);gl.uniform1f(U.u_sb,b?1:0);attr(L.a_s,forms[a].bp,2);attr(L.a_t,forms[b].bp,2);attr(L.a_ls,forms[a].bl,1);attr(L.a_lt,forms[b].bl,1);attr(L.a_c,B.c,3);attr(L.a_r,B.r,4)}
function size(){const dpr=Math.min(devicePixelRatio||1,2),w=Math.round(stage.clientWidth*dpr);cv.width=w;cv.height=Math.round(w*ROWS/COLS);gl.viewport(0,0,cv.width,cv.height)}
function render(u){gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.enable(gl.BLEND);
 gl.uniform2f(U.u_grid,COLS,ROWS);gl.uniform1f(U.u_cell,cv.width/COLS);gl.uniform1f(U.u_t,u);
 gl.blendFunc(gl.ONE,gl.ONE);gl.uniform1f(U.u_pass,1);gl.uniform1f(U.u_fp,1);gl.drawArrays(gl.POINTS,0,nP);
 gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.uniform1f(U.u_pass,0);gl.uniform1f(U.u_fp,0);gl.drawArrays(gl.POINTS,0,nP)}

/* ---------- choreography ---------- */
let cur=0,busy=false,paused=false,auto=true,timer=0,raf=0;
const ease=t=>t;
function setLabel(i){if(!label)return;label.style.opacity=0;setTimeout(()=>{label.textContent=i?'KURO LABS / '+NAMES[i]:LABEL0;label.style.opacity=1},300)}
function morph(to,done){
 if(busy||to===cur){done&&done();return}
 busy=true;const from=cur;bind(from,to);render(0);
 cv.style.transition='none';cv.style.opacity=1;hq(false);frameEl.style.transition='none';frameEl.style.opacity=1;img.style.transition='none';img.style.opacity=0;
 if(label)label.style.opacity=0;
 const t0=performance.now();
 const step=now=>{
  if(paused){raf=requestAnimationFrame(step);return}
  const u=Math.min(1,(now-t0)/DUR);render(u);
  if(u<1)raf=requestAnimationFrame(step);
  else{cur=to;busy=false;
   if(to===0){setLabel(0);img.style.transition='';img.style.opacity=1;setTimeout(()=>{if(cur===0&&!busy){cv.style.opacity=0;frameEl.style.opacity=0}},320)}else{setLabel(to);hq(true,to)}
   done&&done()}};
 raf=requestAnimationFrame(step)}
function loop(){clearTimeout(timer);if(!auto)return;
 timer=setTimeout(()=>{if(paused||busy)return loop();
  const chain=[1,2,3,4,0];let i=0;
  const next=()=>{if(!auto)return;const to=chain[i++];morph(to,()=>{timer=setTimeout(to===0?loop:next,to===0?0:HOLD_S)})};next()},HOLD_K)}
function start(){loadImgs().then(init).catch(()=>{})}
function init(){try{size();build();bind(0,0);addEventListener('resize',()=>{size();render(cur===0?0:1)});loop();
 new IntersectionObserver(e=>{paused=!e[0].isIntersecting}).observe(stage);
 document.addEventListener('visibilitychange',()=>{paused=document.hidden})}catch(err){cv.style.opacity=0;img.style.opacity=1}}
const boot=()=>(window.requestIdleCallback||setTimeout)(start);
const ready=()=>img.decode?img.decode().then(boot,boot):boot();
document.readyState==='complete'?ready():addEventListener('load',ready);
})();
