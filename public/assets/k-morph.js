/* Kuro Labs living K: one continuous point-cloud morph (WebGL).
   Each point carries the artwork's own texel colour. After a one-time hand-over from the static K, the marks are
   ONLY ever drawn by the points: each mark holds as the final frame and flows into the next one from that frame,
   so there is no picture swap anywhere. The ring + stars stay a fixed HD image. Static K for reduced-motion /
   Save-Data / no WebGL / any failure. */
(()=>{
const DUR=4400,HOLD_K=4200,HOLD_S=2600;
const S=1.5,GW=Math.round(480*S),GH=GW,CX=240,CY=240,BOX=440;                // square grid matches the approved K artwork
const stage=document.querySelector('.kl-art .kl-k');if(!stage)return;
const img=stage.querySelector('img'),cv=stage.querySelector('canvas'),label=document.querySelector('.kl-art-label');
if(matchMedia('(prefers-reduced-motion:reduce)').matches||(navigator.connection&&navigator.connection.saveData))return;
const gl=cv.getContext('webgl',{antialias:false,alpha:true,premultipliedAlpha:true});if(!gl)return;
const LABEL0=label?label.textContent:'';
const NAMES=['K','SOFTWARE & AI','3D & VR','WEB DESIGN','BROWSER GAMES'];
const V='?v=20260929',SRC={frame:'/assets/img/k-frame.webp'+V,shapes:[null,1,2,3,4].map(i=>i&&'/assets/img/k-shape-purple-'+i+'.png'+V)};
const GLOW='drop-shadow(0 0 24px #8b5cf666)';

/* ---- fixed HD ring layer sits under the point canvas ---- */
const frameEl=document.createElement('img');frameEl.alt='';frameEl.setAttribute('aria-hidden','true');frameEl.decoding='async';frameEl.src=SRC.frame;
frameEl.style.cssText='position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none;opacity:0;pointer-events:none;z-index:1;transition:none;filter:'+GLOW;
stage.insertBefore(frameEl,cv);
cv.style.zIndex=2;cv.style.transition='none';cv.style.filter=GLOW;

/* ---- sample artwork into point clouds (real texel colours, x1.55 to match the site's CSS brightness) ---- */
const oc=document.createElement('canvas');oc.width=GW;oc.height=GH;const ox=oc.getContext('2d',{willReadFrequently:true});
function sample(draw,test){
 ox.setTransform(1,0,0,1,0,0);ox.clearRect(0,0,GW,GH);ox.imageSmoothingQuality='high';draw(ox);
 const d=ox.getImageData(0,0,GW,GH).data,xs=[],ys=[],cs=[];
 for(let y=0;y<GH;y++)for(let x=0;x<GW;x++){const i=(y*GW+x)*4;if(d[i+3]<110)continue;if(test&&!test((x+.5)/S,(y+.5)/S))continue;
  xs.push(x+.5);ys.push(y+.5);cs.push(Math.min(255,d[i]*1.55),Math.min(255,d[i+1]*1.55),Math.min(255,d[i+2]*1.55),255)}
 return{n:xs.length,x:Float32Array.from(xs),y:Float32Array.from(ys),c:Uint8Array.from(cs)}}
let forms=[],shapeImgs=[];
function buildForms(){
 forms=[sample(c=>c.drawImage(img,0,0,GW,GH))];
 for(let s=1;s<=4;s++)forms.push(sample(c=>c.drawImage(shapeImgs[s],(CX-BOX/2)*S,(CY-BOX/2)*S,BOX*S,BOX*S)))}

/* ---- pair two clouds so neighbours stay neighbours: recursive median bisection with native numeric sorts.
        Runs in a Web Worker (falls back to the main thread). ---- */
function match(ax,ay,na,bx,by,nb){
 const N=Math.max(na,nb),M=524288;let seed=12345;const rnd=()=>(seed=(seed*1664525+1013904223)>>>0)/4294967296;
 const IA=new Int32Array(N),IB=new Int32Array(N),ka=new Float64Array(N),kb=new Float64Array(N);
 for(let i=0;i<N;i++){IA[i]=i<na?i:Math.floor(rnd()*na);IB[i]=i<nb?i:Math.floor(rnd()*nb)}
 (function bis(lo,hi){
  const n=hi-lo;if(n<2)return;
  let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;
  for(let i=lo;i<hi;i++){const a=IA[i],b=IB[i];x0=Math.min(x0,ax[a],bx[b]);x1=Math.max(x1,ax[a],bx[b]);y0=Math.min(y0,ay[a],by[b]);y1=Math.max(y1,ay[a],by[b])}
  const cA=(x1-x0)>=(y1-y0)?ax:ay,cB=cA===ax?bx:by;
  for(let i=lo;i<hi;i++){ka[i]=Math.floor(cA[IA[i]])*M+IA[i];kb[i]=Math.floor(cB[IB[i]])*M+IB[i]}
  ka.subarray(lo,hi).sort();kb.subarray(lo,hi).sort();
  for(let i=lo;i<hi;i++){IA[i]=ka[i]%M;IB[i]=kb[i]%M}
  if(n<=16)return;const m=lo+(n>>1);bis(lo,m);bis(m,hi)})(0,N);
 return{IA,IB,N}}
let worker=null;
try{worker=new Worker(URL.createObjectURL(new Blob(['const match='+match.toString()+';onmessage=e=>{const d=e.data,r=match(d.ax,d.ay,d.na,d.bx,d.by,d.nb);postMessage(r,[r.IA.buffer,r.IB.buffer])}'],{type:'text/javascript'})))}catch(e){worker=null}
function pairAsync(fa,fb){return new Promise(res=>{
 if(worker){worker.onmessage=e=>res(e.data);worker.onerror=()=>{worker=null;res(match(fa.x,fa.y,fa.n,fb.x,fb.y,fb.n))};worker.postMessage({ax:fa.x,ay:fa.y,na:fa.n,bx:fb.x,by:fb.y,nb:fb.n})}
 else setTimeout(()=>res(match(fa.x,fa.y,fa.n,fb.x,fb.y,fb.n)),20)})}
async function pairUp(a,b){
 const fa=forms[a],fb=forms[b],{IA,IB,N}=await pairAsync(fa,fb);
 const s=new Float32Array(N*2),t=new Float32Array(N*2),ca=new Uint8Array(N*4),cb=new Uint8Array(N*4),r=new Float32Array(N*3);
 for(let i=0;i<N;i++){const p=IA[i],q=IB[i];s[i*2]=fa.x[p];s[i*2+1]=fa.y[p];t[i*2]=fb.x[q];t[i*2+1]=fb.y[q];
  ca.set(fa.c.subarray(p*4,p*4+4),i*4);cb.set(fb.c.subarray(q*4,q*4+4),i*4);r[i*3]=Math.random();r[i*3+1]=Math.random();r[i*3+2]=Math.random()}
 return upload({n:N,s,t,ca,cb,r})}

/* ---- WebGL ---- */
const VS=`attribute vec2 a_s,a_t;attribute vec3 a_ca,a_cb,a_r;uniform float u_t,u_cell,u_k,u_pat;uniform vec2 u_grid;varying vec3 v_c;
float ss(float x){x=clamp(x,0.,1.);return x*x*x*(x*(x*6.-15.)+10.);}
float hh(float x){return fract(sin(x*127.1+311.7)*43758.5453);}
vec3 rotX(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(p.x,c*p.y-s*p.z,s*p.y+c*p.z);}
vec3 rotY(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);}
vec3 rotZ(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(c*p.x-s*p.y,s*p.x+c*p.y,p.z);}
void main(){
 float T=clamp((u_t-a_r.x*.14)/.86,0.,1.);
 float a=ss(T/.34),b=ss((T-.66)/.34);
 vec2 ctr=.5*u_grid;

 float U=a_r.y,W=a_r.z,X=fract(a_r.x*91.7+U*13.1),Y=fract(a_r.x*37.3+W*29.9),R=186.*u_k,TP=6.28318,dep=1.,jw=5.;
 vec3 q=vec3(0.);
 if(u_pat<.5){                                   // 0 star compass: four-point star, tick ring, inner ring
  if(W<.55){float th=U*TP,env=pow(pow(abs(cos(th)),.6667)+pow(abs(sin(th)),.6667),-2.55),ang=th+u_t*.8;q=vec3(cos(ang),sin(ang),0.)*env*.98*R*sqrt(X);jw=0.;}
  else if(W<.82){float g=floor(U*72.),th=g/72.*TP-u_t*.5,len=mod(g,6.)<.5?.14:(mod(g,2.)<.5?.07:.04);q=vec3(cos(th),sin(th),0.)*R*(.97-len*X);jw=2.6;}
  else{float th=U*TP-u_t*.5;q=vec3(cos(th),sin(th),0.)*R*.5;jw=4.;}
 }else if(u_pat<1.5){                            // 1 gyroscope: three rings tilting in 3D
  if(W<.96){float k=floor(W/.32),t=U*TP,rr=(k<.5?.97:(k<1.5?.79:.61))*R;vec3 p=vec3(cos(t),sin(t),0.)*rr;
   if(k<.5)p=rotX(p,u_t*1.3+.7);else if(k<1.5){p=rotY(p,u_t*1.7+1.2);p=rotZ(p,.5);}else{p=rotX(p,-u_t*1.1+1.6);p=rotZ(p,-.7);}
   q=p;dep=.6+.4*(p.z/R*.5+.5);jw=8.;}
  else{float th=Y*TP;q=vec3(cos(th),sin(th),0.)*.1*R*sqrt(X);jw=0.;}
 }else if(u_pat<2.5){                            // 2 wireframe cubes (outer + counter-rotating inner) with perspective
  float e=floor(W*12.),ax=floor(e/4.),a4=mod(e,4.),s1=mod(a4,2.)*2.-1.,s2=floor(a4/2.)*2.-1.,tt=U*2.-1.;
  vec3 p=ax<.5?vec3(tt,s1,s2):(ax<1.5?vec3(s2,tt,s1):vec3(s1,s2,tt));
  float inner=X<.3?1.:0.,dir=inner>.5?-1.:1.;p*=.5*R*(inner>.5?.5:1.);
  p=rotY(p,u_t*1.2*dir);p=rotX(p,.55+u_t*.8*dir);jw=7.;
  float f=1./(1.-p.z/(4.*R));q=vec3(p.xy*f,p.z);dep=clamp(.55+.45*(p.z/(.9*R)*.5+.5),0.,1.);
 }else if(u_pat<3.5){                            // 3 DNA helix with rungs
  float t=U*2.-1.,ang=t*TP*1.4+u_t*2.6;vec3 p;
  if(W<.7){float sgn=W<.35?0.:3.14159,a2=ang+sgn;p=vec3(cos(a2)*.5*R,t*.93*R,sin(a2)*.5*R);jw=7.;}
  else{float tq=floor(U*22.)/22.*2.-1.,a2=tq*TP*1.4+u_t*2.6;vec3 p1=vec3(cos(a2),0.,sin(a2))*.5*R,p2=-p1;p=mix(p1,p2,X);p.y=tq*.93*R;jw=3.5;}
  p=rotZ(p,.38);q=p;dep=clamp(.55+.45*(p.z/(.5*R)*.5+.5),0.,1.);
 }else{                                          // 4 rune circle: rings, counter-rotating triangles, glyph band, centre star
  if(W<.12){float th=U*TP+u_t*.4;q=vec3(cos(th),sin(th),0.)*R*(.97+(X-.5)*.01);jw=3.5;}
  else if(W<.2){float th=U*TP-u_t*.3;q=vec3(cos(th),sin(th),0.)*R*(.6+(X-.5)*.01);jw=3.5;}
  else if(W<.46){float tri=W<.33?0.:1.,e=floor(X*3.),rot=(tri<.5?1.:-1.)*u_t*.6+tri*1.0472;
   float a0=rot+e*2.0944,a1=rot+(e+1.)*2.0944;vec2 v0=vec2(cos(a0),sin(a0))*.78*R,v1=vec2(cos(a1),sin(a1))*.78*R;q=vec3(mix(v0,v1,U),0.);jw=4.;}
  else if(W<.88){float g=floor(U*12.),ca=g*TP/12.+u_t*.5,s=floor(Y*3.);
   vec2 p0=vec2(hh(g*7.+s*1.3)-.5,hh(g*3.1+s*2.7)-.5)*.13*R,p1=vec2(hh(g*5.3+s*.7+9.)-.5,hh(g*11.+s*4.1+2.)-.5)*.13*R;
   vec2 lp=mix(p0,p1,fract(X*13.7+U*5.));float c=cos(ca+1.5708),sn=sin(ca+1.5708);
   q=vec3(vec2(cos(ca),sin(ca))*.79*R+vec2(c*lp.x-sn*lp.y,sn*lp.x+c*lp.y),0.);jw=3.;}
  else{float th=U*TP,env=.15+.85*pow(abs(cos(2.*th)),2.4),ang=th-u_t*.9;q=vec3(cos(ang),sin(ang),0.)*env*.24*R*sqrt(X);jw=0.;}
 }
 vec2 V=q.xy+(vec2(fract(X*7.3),fract(Y*5.1))-.5)*jw*u_k;
 float rv=length(V),phv=atan(V.y,V.x),rn=rv/R;
 vec2 sc=a_s-ctr,tc=a_t-ctr;
 float rs=length(sc),ths=atan(sc.y,sc.x),rt=length(tc),tht=atan(tc.y,tc.x);
 float dA=mod(phv-ths+3.14159,6.28318)-3.14159,dB=mod(tht-phv+3.14159,6.28318)-3.14159;
 vec2 p;
 if(b>0.){float r=mix(rv,rt,b),g=phv+dB*b+.9*sin(3.14159*b);p=ctr+vec2(cos(g),sin(g))*r;}
 else{float r=mix(rs,rv,a),g=ths+dA*a+.9*sin(3.14159*a);p=ctr+vec2(cos(g),sin(g))*r;}
 gl_Position=vec4(p.x/u_grid.x*2.-1.,1.-p.y/u_grid.y*2.,0.,1.);
 gl_PointSize=u_cell*(1.+.45*a*(1.-b));
 float core=a*(1.-b)*(1.-smoothstep(0.,.22,rn));
 v_c=mix(a_ca,a_cb,ss((T-.42)/.16))*(1.+.8*core)*mix(1.,dep,a*(1.-b));}`;
const FS=`precision mediump float;varying vec3 v_c;
void main(){float a=smoothstep(.5,.2,length(gl_PointCoord-.5));if(a<=0.)discard;gl_FragColor=vec4(v_c*a,a);}`;
const sh=(t,s)=>{const o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);if(!gl.getShaderParameter(o,gl.COMPILE_STATUS))throw gl.getShaderInfoLog(o);return o};
const prog=gl.createProgram();gl.attachShader(prog,sh(gl.VERTEX_SHADER,VS));gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,FS));gl.linkProgram(prog);
if(!gl.getProgramParameter(prog,gl.LINK_STATUS))throw gl.getProgramInfoLog(prog);gl.useProgram(prog);
const L={};['a_s','a_t','a_ca','a_cb','a_r'].forEach(n=>L[n]=gl.getAttribLocation(prog,n));
const U={};['u_t','u_cell','u_grid','u_k','u_pat'].forEach(n=>U[n]=gl.getUniformLocation(prog,n));
function buf(data){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);return b}
function upload(P){P.g={s:buf(P.s),t:buf(P.t),ca:buf(P.ca),cb:buf(P.cb),r:buf(P.r)};P.s=P.t=P.ca=P.cb=P.r=null;return P}
function free(P){if(P&&P.g){for(const k in P.g)gl.deleteBuffer(P.g[k]);P.g=null}}
function attr(loc,b,n,type,norm,stride){gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,n,type||gl.FLOAT,!!norm,stride||0,0)}
let P=null,lastU=0,stopped=false,pat=0;
function alive(){const w=cv.width,h=cv.height,px=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px);let n=0;for(let i=3;i<px.length;i+=16)if(px[i])n++;return n>200&&gl.getError()===gl.NO_ERROR}
function fallback(){stopped=true;clearTimeout(timer);cv.style.transition='none';cv.style.opacity=0;frameEl.style.opacity=0;img.style.transition='none';img.style.opacity=1;if(label){label.textContent=LABEL0;label.style.opacity=1}}
cv.addEventListener('webglcontextlost',e=>{e.preventDefault();fallback()});
function use(p){const old=P;P=p;attr(L.a_s,p.g.s,2);attr(L.a_t,p.g.t,2);attr(L.a_ca,p.g.ca,3,gl.UNSIGNED_BYTE,true,4);attr(L.a_cb,p.g.cb,3,gl.UNSIGNED_BYTE,true,4);attr(L.a_r,p.g.r,3);return old}
function size(){const dpr=Math.min(devicePixelRatio||1,2),w=Math.round(stage.clientWidth*dpr);cv.width=w;cv.height=Math.round(w*GH/GW);gl.viewport(0,0,cv.width,cv.height)}
function render(u){lastU=u;gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
 gl.uniform2f(U.u_grid,GW,GH);gl.uniform1f(U.u_k,S);gl.uniform1f(U.u_pat,pat);gl.uniform1f(U.u_cell,Math.max(1.7,cv.width/GW*1.6));gl.uniform1f(U.u_t,u);gl.drawArrays(gl.POINTS,0,P.n)}

/* ---- choreography ---- */
let cur=0,busy=false,paused=false,timer=0;const prep={};
const key=(a,b)=>a+'>'+b;
const prepare=(a,b)=>prep[key(a,b)]||(prep[key(a,b)]=pairUp(a,b));
function setLabel(i){if(!label)return;label.style.opacity=0;setTimeout(()=>{label.textContent=i?'KURO LABS / '+NAMES[i]:LABEL0;label.style.opacity=1},320)}
async function morph(to){
 if(busy)return;busy=true;const from=cur,p=await prepare(from,to),old=use(p);pat=chain.indexOf(to);
 render(0);if(old&&old!==p)free(old);                                    // frame 0 == the frame the previous morph ended on
 if(label)label.style.opacity=0;
 await new Promise(res=>{let elapsed=0,last=performance.now();
  const step=now=>{const dt=now-last;last=now;if(!paused)elapsed+=Math.min(dt,50);
   const u=Math.min(1,elapsed/DUR);render(u);if(u<1)requestAnimationFrame(step);else res()};
  requestAnimationFrame(step)});
 if(!alive()){fallback();busy=false;return}
 cur=to;busy=false;setLabel(to);delete prep[key(from,to)]}
const chain=[1,2,3,4,0];
function loop(){clearTimeout(timer);
 timer=setTimeout(async()=>{if(stopped)return;if(paused||busy)return loop();
  for(const to of chain){await morph(to);if(stopped)return;
   const nxt=chain[(chain.indexOf(to)+1)%chain.length];prepare(to,nxt);
   await new Promise(r=>{timer=setTimeout(r,to===0?0:HOLD_S)})}
  loop()},HOLD_K)}

/* ---- boot: after load + idle, never blocks first paint. One-time hand-over from the static K to the points. ---- */
const load=u=>new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=u});
async function start(){
 try{
  const r=await Promise.all([load(SRC.frame),...SRC.shapes.slice(1).map(load)]);frameEl.src=SRC.frame;shapeImgs=[null,...r.slice(1)];
  size();buildForms();
  const p=await prepare(0,1);use(p);render(0);if(!alive())throw new Error('blank canvas');
  cv.style.transition='opacity .35s';cv.style.opacity=1;frameEl.style.opacity=0;              // ring is pixel-identical to the K image's ring
  setTimeout(()=>{img.style.transition='none';img.style.opacity=0},400);                     // K picture is only the first paint / no-JS fallback
  addEventListener('resize',()=>{size();if(P&&P.g)render(lastU)});
  new IntersectionObserver(e=>{paused=!e[0].isIntersecting}).observe(stage);
  document.addEventListener('visibilitychange',()=>{paused=document.hidden});
  loop();
 }catch(err){cv.style.opacity=0;frameEl.style.opacity=0;img.style.transition='none';img.style.opacity=1}}
const boot=()=>(window.requestIdleCallback||setTimeout)(start);
const ready=()=>img.decode?img.decode().then(boot,boot):boot();
document.readyState==='complete'?ready():addEventListener('load',ready);
window.__kmorph={morph};
})();
