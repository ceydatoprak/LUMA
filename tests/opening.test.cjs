// Opening chapter: follow the intended sequence from the actual preceding
// landing, then replay it using touch-style pointer events on a phone viewport.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {boot}=require('./harness.cjs');
const f=boot(), T=f.internals;
assert.equal(f.GAME.title,'LUMA');assert.equal(f.TEXT.tagline,'Işığın yolunu bul.');
assert.equal(f.GAME.storageKey,'flux');
assert.equal(f.text('menuTagline'),f.TEXT.tagline);
const results=[];
let touchReplay=false;
const pointer=(x,y)=>({clientX:x,clientY:y,pointerId:1,pointerType:'touch',button:0,preventDefault(){},target:f.canvas});
function snap(){return {body:{...f.body},PS:{...f.PS},G:{...f.G},nodes:f.world.nodes.map(e=>({...e})),springs:f.world.springs.map(e=>({...e})),loop:{...T.springLoop}};}
function restore(s){Object.assign(f.body,s.body);Object.assign(f.PS,s.PS);Object.assign(f.G,s.G);f.world.nodes.forEach((e,i)=>Object.assign(e,s.nodes[i]));f.world.springs.forEach((e,i)=>Object.assign(e,s.springs[i]));Object.assign(T.springLoop,s.loop);f.Aim.on=false;}
function floor(wp){return f.world.solids.find(e=>Math.abs(e.y-e.h/2-wp[1]-13)<2 && Math.abs(e.x-wp[0])<=e.w/2);}
function advance(wp){
  for(let j=0;j<250;j++){
    f.tick(1);
    if(f.G.phase==='win')return wp[2]==='gate'||(wp[2]==='ground'&&wp[1]<350);
    if(f.PS.state==='hurt'||f.PS.state==='spawn')return false;
    if(wp[2]==='spring'&&f.world.springs.some(e=>e.fire>.9))return true;
    if(wp[2]==='node') {const n=T.nodeInReach();if(n){
      if(touchReplay){f.events.pointerdown(pointer(230,340));assert.equal(f.PS.state,'node');f.tick(30);}
      else {T.grabNode(n,270,480,null);f.tick(30);f.Aim.on=false;}
      return true;
    }}
    if(T.canAim()) {
      if(wp[2]==='cling')return f.PS.state==='cling'&&Math.abs(f.body.x-wp[0])<30;
      if(wp[2]==='ground'){const e=floor(wp);return f.PS.state==='ground'&&e&&Math.abs(f.body.y+13-(e.y-e.h/2))<2&&Math.abs(f.body.x-e.x)<e.w/2;}
      return false;
    }
  }return false;
}
function solve(li,route){
 f.go(li);f.tick(60);let states=[{s:snap(),path:[]}];
 for(let stage=1;stage<route.length;stage++){
   const next=[];
   for(const v of states){
     if(v.s.G.phase==='win')return v.path;
     if(route[stage-1][2]==='spring') {restore(v.s);if(advance(route[stage]))next.push({s:snap(),path:[...v.path,{auto:true,target:route[stage]}]});continue;}
     const powers=li===0&&stage===1?[.4,.45,.5]:li===0&&stage===2?[.55,.6,.65]:li===0&&stage===3?[.1,.2,.3]:li===4?[.1,.25,.4,.55,.7,.85]:[.1,.25,.4,.55,.7];
     for(const p of powers)for(let deg=-170;deg<=-10;deg+=5){
       restore(v.s); if(!T.canAim())continue;
       if(route[stage][2]==='spring') {
         f.Aim.on=true;f.Aim.angle=deg*Math.PI/180;f.Aim.power=p;f.Aim.pullLen=100;
         T.updateCamera(true);const e=floor(route[stage+1]);
         const seen=e.x-e.w/2<f.cam.x+270/f.cam.zoom && e.y-e.h/2>f.cam.y-480/f.cam.zoom;
         f.Aim.on=false;if(!seen)continue;
       }
       f.burst(deg*Math.PI/180,p);
       if(advance(route[stage]))next.push({s:snap(),path:[...v.path,{deg,p,target:route[stage]}]});
     }
   }
   assert(next.length,`L${li+1} sequential stage ${stage} ${route[stage][2]} unreachable`);
   const seen=new Set();states=next.sort((a,b)=>Math.hypot(a.s.body.x-route[stage][0],a.s.body.y-route[stage][1])-Math.hypot(b.s.body.x-route[stage][0],b.s.body.y-route[stage][1])).filter(v=>{const k=Math.round(v.s.body.x/15)+":"+Math.round(v.s.body.y/15);if(seen.has(k))return false;seen.add(k);return true;}).slice(0,24);
 }
 const win=states.find(v=>v.s.G.phase==='win');assert(win,`L${li+1} must finish`);return win.path;
}
const nearest=(list,wp)=>list.reduce((b,e)=>(!b||Math.hypot(e.x-wp[0],e.y-wp[1])<Math.hypot(b.x-wp[0],b.y-wp[1]))?e:b,null);
/* The face a cling waypoint is holding: the solid whose side the spirit is
   resting one radius clear of, at that height. */
const face=(wp)=>f.world.solids.find(e=>!e.a && wp[1]>e.y-e.h/2 && wp[1]<e.y+e.h/2 &&
  (Math.abs(wp[0]-(e.x-e.w/2-13))<6 || Math.abs(wp[0]-(e.x+e.w/2+13))<6));
function visibleTarget(wp){
 const obj=wp[2]==='ground'?floor(wp):wp[2]==='node'?nearest(f.world.nodes,wp)
   :wp[2]==='spring'?nearest(f.world.springs,wp):wp[2]==='cling'?face(wp):f.world.gate;
 assert(obj,`waypoint names something that exists: ${JSON.stringify(wp)}`);
 const hx=obj.w?obj.w/2:obj.r, hy=obj.h?obj.h/2:obj.r;
 assert(obj.x+hx>f.cam.x-270/f.cam.zoom && obj.x-hx<f.cam.x+270/f.cam.zoom && obj.y+hy>f.cam.y-480/f.cam.zoom && obj.y-hy<f.cam.y+480/f.cam.zoom,'required destination must be revealed before release');
}
function touchShot(deg,p,target){
  // Invert the unchanged smoothstep power curve to obtain finger distance.
  let lo=0,hi=1;for(let i=0;i<30;i++){const m=(lo+hi)/2;if(T.powerCurve(m)<p)lo=m;else hi=m;}
  const len=f.MOVE.dragDead+(f.MOVE.dragFull-f.MOVE.dragDead)*(lo+hi)/2;
  const scale=390/540, a=deg*Math.PI/180;
  const event=pointer;
  if(!f.Aim.on) f.events.pointerdown(event(230,340));f.events.pointermove(event(230-Math.cos(a)*len*scale,340-Math.sin(a)*len*scale));
  assert(f.Aim.on,'touch must acquire a decision');
  // Human planning time, with a stationary finger and stable aim camera.
  f.tick(150);
  visibleTarget(target);
  if(target[2]==='spring') visibleTarget(f.LEVELS[f.G.levelIndex].route.find((wp,i,route)=>i>0&&route[i-1][2]==='spring'));
  f.events.pointerup(event(230-Math.cos(a)*len*scale,340-Math.sin(a)*len*scale));
}
for(let li=0;li<5;li++){
 const L=f.LEVELS[li];assert(!L.winds&&!L.beams&&!L.motes);assert(!L.solids.some(e=>e.motion||e.crumble));
 // Nodes are introduced in level 3 and springs in level 4. Nothing may show
 // up before its own level; after that a level is free not to use it again.
 assert(li>=2||(L.nodes||[]).length===0,`L${li+1} shows nodes before level 3`);
 assert(li>=3||(L.springs||[]).length===0,`L${li+1} shows springs before level 4`);
 if(li===2) assert((L.nodes||[]).length>0,'level 3 introduces the node');
 if(li===3) assert((L.springs||[]).length>0,'level 4 introduces the spring');
 // a mechanic's first appearance is safe, so it may appear more than once
 assert((L.nodes||[]).length<=2 && (L.springs||[]).length<=2,`L${li+1} introduces too much at once`);
 for(const [label,route] of [['safe',L.route],...(L.fastRoute?[['fast',L.fastRoute]]:[])]){
  touchReplay=false;const path=solve(li,route);f.go(li);f.resize(390,390*960/540);f.tick(60);touchReplay=true;
  for(const shot of path){if(!shot.auto)touchShot(shot.deg,shot.p,shot.target);assert(advance(shot.target),`L${li+1} touch replay ${label}: ${JSON.stringify(shot)}`);if(f.G.phase==='win')break;}
  assert.equal(f.G.phase,'win');results.push({level:li+1,route:label,path});console.log(`PASS L${li+1} ${label}: sequential touch replay (${path.filter(s=>!s.auto).length} pulls)`);
 }
}
fs.writeFileSync(require('node:path').join(__dirname,'opening-routes.json'),JSON.stringify(results,null,2));



