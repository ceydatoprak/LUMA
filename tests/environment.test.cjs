const assert = require('node:assert/strict');
const {boot} = require('./harness.cjs');
const f=boot(), T=f.internals;
assert.equal(f.LEVELS.length,15);
assert.equal(f.G.menu,true);
assert.equal(f.selectLevel(1),false);
assert.equal(f.el('chooseLevel1').disabled,true);
assert(f.selectLevel(0));
f.Save.complete(0); f.showMenu(true);
assert.equal(f.el('chooseLevel1').disabled,false);
assert(f.selectLevel(1));
const reload=boot({storage:f.storage.dump()});
assert.equal(reload.Save.unlocked(),1);
assert.equal(reload.G.menu,true);
assert.equal(reload.selectLevel(2),false);

// Actual landing, then two complete cycles riding horizontal AND vertical motion.
for (const li of [6,9,12,13,14]) {
  f.go(li); const e=f.world.movers[0];
  T.placeSpirit(e.x,e.y-e.h/2-20); f.PS.state='air'; f.PS.t=1;
  for(let j=0;j<30 && f.PS.state!=='ground';j++) f.tick(1);
  assert.equal(f.PS.state,'ground',`L${li+1} landing`);
  f.body.vx=0;const offset=f.body.x-e.x;
  for(let j=0;j<1200;j++) {
    f.tick(1);
    assert(Number.isFinite(e.x)&&Number.isFinite(e.y));
    assert.equal(f.PS.state,'ground',`L${li+1} rider detached at ${j}`);
    assert(Math.abs(f.body.x-e.x-offset)<.1,`L${li+1} rider drift`);
    assert(Math.abs(f.body.y+f.body.r-(e.y-e.h/2))<.2,`L${li+1} jitter`);
  }
  const before=JSON.stringify([e.x,e.y,e.vx,e.vy,e.px,e.py]);
  T.predict(f.body.x,f.body.y,9,-13,1000);
  assert.equal(JSON.stringify([e.x,e.y,e.vx,e.vy,e.px,e.py]),before,'prediction must restore motion');
}
for(const li of [7,12,14]) {
  f.go(li); const e=f.world.solids.find(e=>e.crumble);
  T.placeSpirit(e.x,e.y-e.h/2-20); f.PS.state='air'; f.PS.t=1;
  f.tick(20); assert(e.crumbleT>=0); assert(!e.broken);
  const timer=e.crumbleT; f.Aim.on=true; f.tick(120); assert.equal(e.crumbleT,timer);
  f.Aim.on=false; f.tick(Math.ceil(e.crumble*60));assert(e.broken);
  T.respawn();assert(!e.broken);assert.equal(e.crumbleT,-1);
  e.broken=true; T.restartLevel(true);assert(!f.world.solids.find(e=>e.crumble).broken);
}
f.go(10); const w=f.world.winds[0];
const probe={x:w.x,y:w.y,vx:0,vy:0,burst:1}; T.integrate(probe);
assert(probe.vx>0 && probe.vy<0,'wind follows its visible direction');
f.PS.state='ground'; f.body.x=w.x;f.body.y=w.y;f.body.vx=0;f.body.vy=0;f.body.burst=1;T.integrate(f.body);
assert.equal(f.body.vx,0,'wind leaves resting body alone');

// The actual platform-aware forecast matches the live flight's first contact.
f.go(6); f.tick(60);
const p=T.predict(f.body.x,f.body.y,11,-12,2000);
const target={x:p.lx,y:p.ly,land:p.land};
assert(target.land>=0);
f.body.vx=11;f.body.vy=-12;f.body.burst=f.MOVE.burstTime;f.PS.state='air';f.PS.coyote=0;
for(let j=0;j<150;j++){f.tick(1);if(f.PS.state==='ground'||f.PS.state==='cling')break;}
assert(Math.hypot(f.body.x-target.x,f.body.y-target.y)<1,'moving landing preview matches live flight');
// Every spring layout must hand control back after one automatic throw,
// including off-centre approaches, without activating the loop failsafe.
for(let li=0;li<15;li++) for(let si=0;si<(f.LEVELS[li].springs||[]).length;si++) {
  for(const offset of [-.25,0,.25]) {
    f.go(li); f.tick(120); // observe the safe beam window before committing
    const sp=f.world.springs[si];
    T.placeSpirit(sp.x+sp.ca*sp.w*offset+sp.sa*48,sp.y+sp.sa*sp.w*offset-sp.ca*48);
    f.PS.state='air';f.PS.t=1;f.body.vy=2;
    let launches=0, previous=0, controlled=false;
    for(let j=0;j<450;j++) {
      f.tick(1); if(sp.fire>previous+.1) launches++; previous=sp.fire;
      assert(!sp.off,`L${li+1} spring geometry trips failsafe`);
      if(f.aimable() || f.G.phase==='win') {controlled=true;break;}
      if(f.PS.state==='hurt') break;
    }
    assert.equal(launches,1,`L${li+1} spring should fire once`);
    assert(controlled,`L${li+1} spring must land safely`);
  }
}
const old=boot({storage:{'flux.progress':JSON.stringify({v:1,unlocked:5,done:[0,1,2,3,4,5]})}});
assert.equal(old.Save.unlocked(),6,'old complete saves unlock newly added level seven');
console.log('PASS: 15 levels; menu locks/save reload; moving landings and 20-second rides; forecast isolation/parity; crumbling warning/pause/reset; directional airborne wind.');

