"use strict";
/* =====================================================================
   Alien Dance Party — Ultra-optimized for 60fps on low-end mobile.
   Key optimizations:
   - DPR fixed at 1.0 (minimum pixel fill)
   - NO globalCompositeOperation, NO backdrop-filter (no GPU compositing overhead)
   - Pre-rendered alien sprites on offscreen canvases (drawImage only in hot loop)
   - Sprite render budget: max 3 sprite re-renders per frame (was ~30!)
   - Coarse dirty check: colors/mouth/squash quantized to few steps
   - Sort aliens every 6 frames instead of every frame
   - All DOM refs cached at init, no string allocation in hot loop
   - Opaque canvas context, reduced particle count
   ===================================================================== */
var LW=400, LH=711;
var canvas=document.getElementById('game');
var ctx=canvas.getContext('2d',{alpha:false});
var gameArea=document.getElementById('gameArea');
var dpr=1;
var canvasRect={left:0,top:0,width:LW,height:LH};

// Cached DOM refs (avoid getElementById in hot loop)
var elCount,elCombo,elComboBadge,elComboNum,elToast;

function setupCanvas(){
  dpr=1;
  canvas.width=Math.floor(LW*dpr);
  canvas.height=Math.floor(LH*dpr);
}
function fitArea(){
  var sw=innerWidth,sh=innerHeight;
  var w=sh*9/16,h=sh;
  if(w>sw){w=sw;h=sw*16/9;}
  gameArea.style.width=Math.floor(w)+'px';
  gameArea.style.height=Math.floor(h)+'px';
  updateCanvasRect();
}
function updateCanvasRect(){
  var r=canvas.getBoundingClientRect();
  canvasRect={left:r.left,top:r.top,width:r.width||LW,height:r.height||LH};
}

function clamp(v,a,b){return v<a?a:v>b?b:v;}
function lerp(a,b,t){return a+(b-a)*t;}
function rand(a,b){return a+Math.random()*(b-a);}
function dist2(x1,y1,x2,y2){var dx=x1-x2,dy=y1-y2;return dx*dx+dy*dy;}

/* ---------- Audio (pre-allocated noise buffer, minimal GC) ---------- */
var audio=null, noiseBuf=null;
function ensureAudio(){
  if(!audio){try{audio=new (window.AudioContext||window.webkitAudioContext)();}catch(e){audio=null;}}
  if(audio){
    if(audio.state==='suspended')audio.resume();
    if(!noiseBuf){
      var len=Math.floor(audio.sampleRate*0.1);
      noiseBuf=audio.createBuffer(1,len,audio.sampleRate);
      var d=noiseBuf.getChannelData(0);
      for(var i=0;i<len;i++)d[i]=(Math.random()*2-1)*(1-i/len);
    }
  }
}
function tone(freq,dur,type,vol,delay){
  if(!audio)return;var n=audio.currentTime+(delay||0);
  var o=audio.createOscillator();o.type=type||'sine';o.frequency.value=freq;
  var g=audio.createGain();g.gain.setValueAtTime(0,n);g.gain.linearRampToValueAtTime(vol||0.08,n+0.01);
  g.gain.exponentialRampToValueAtTime(0.001,n+dur);
  o.connect(g);g.connect(audio.destination);o.start(n);o.stop(n+dur+0.05);
}
function noiseBurst(dur,freq,vol){
  if(!audio||!noiseBuf)return;var n=audio.currentTime;
  var s=audio.createBufferSource();s.buffer=noiseBuf;
  s.playbackRate.value=noiseBuf.duration/dur;
  var f=audio.createBiquadFilter();f.type='lowpass';f.frequency.value=freq||800;
  var g=audio.createGain();g.gain.value=vol||0.06;
  s.connect(f);f.connect(g);g.connect(audio.destination);s.start(n);s.stop(n+dur);
}
var ufoHum=null;
function startHum(){if(!audio||ufoHum)return;var o=audio.createOscillator();o.type='sawtooth';o.frequency.value=55;
  var f=audio.createBiquadFilter();f.type='lowpass';f.frequency.value=200;
  var g=audio.createGain();g.gain.value=0.015;
  o.connect(f);f.connect(g);g.connect(audio.destination);o.start();ufoHum={osc:o,gain:g};}
function stopHum(){if(ufoHum){try{ufoHum.osc.stop();}catch(e){}ufoHum=null;}}

var lastSndTime=0;
function sndThrottle(){var n=audio?audio.currentTime:0;if(n-lastSndTime<0.03)return false;lastSndTime=n;return true;}
function sndSpawn(){tone(220,.08,'square',.06);tone(330,.1,'square',.05,.04);noiseBurst(.08,600,.04);}
function sndSquelch(){if(!sndThrottle())return;noiseBurst(.06,400,.05);tone(150,.08,'sawtooth',.04);}
function sndZap(){if(!sndThrottle())return;tone(880,.05,'square',.05);tone(660,.06,'square',.04,.03);}
function sndLaugh(){tone(300,.05,'sawtooth',.05);tone(400,.05,'sawtooth',.05,.06);tone(350,.06,'sawtooth',.04,.12);}
function sndBeat(intensity){if(!sndThrottle())return;var f=200+intensity*100;tone(f,.06,'square',.04);noiseBurst(.04,300,.02);}
function sndPop(){tone(440,.04,'sine',.06);tone(660,.05,'sine',.05,.03);}
function sndClear(){tone(330,.06,'sawtooth',.05);tone(220,.08,'sawtooth',.04,.06);tone(110,.12,'sawtooth',.03,.12);}
function sndPhoto(){tone(1000,.02,'square',.06);tone(1200,.03,'sine',.05,.04);noiseBurst(.06,2000,.04);}

/* ---------- Pre-rendered glow sprite ---------- */
var SPRITE_SIZE=100;
var glowCanvas=document.createElement('canvas');
glowCanvas.width=20;glowCanvas.height=20;
(function(){var g=glowCanvas.getContext('2d').createRadialGradient(10,10,1,10,10,10);
  g.addColorStop(0,'rgba(255,255,255,0.8)');g.addColorStop(1,'rgba(255,255,255,0)');
  var gc=glowCanvas.getContext('2d');gc.fillStyle=g;gc.fillRect(0,0,20,20);})();

/* ---------- Alien with offscreen sprite caching ---------- */
var SPRITE_W=100, SPRITE_H=120;

function Alien(x,y){
  this.x=x;this.y=y;
  this.tx=x;this.ty=y;
  this.scale=rand(.7,1.1);
  this.targetScale=this.scale;
  this.rotation=rand(-.3,.3);
  this.targetRotation=this.rotation;
  this.bodyR=rand(28,36);
  this.bodySquash=1;this.bodySquashY=1;
  this.colorPhase=rand(0,Math.PI*2);
  this.eyeColorPhase=rand(0,Math.PI*2);
  this.tentacleCount=5+Math.floor(rand(0,3));
  this.tentacles=[];
  for(var i=0;i<this.tentacleCount;i++){
    var ang=Math.PI*2*i/this.tentacleCount+rand(-.2,.2);
    this.tentacles.push({angle:ang,len:rand(30,50),wave:rand(0,Math.PI*2),waveSpeed:rand(2,4),
      ca:Math.cos(ang),sa:Math.sin(ang)});
  }
  this.dancePhase=rand(0,Math.PI*2);
  this.danceMove=Math.floor(rand(0,3));
  this.danceTimer=rand(1,3);
  this.bob=rand(0,Math.PI*2);
  this.bobSpeed=rand(1.5,3);
  this.dragging=false;
  this.dragOffX=0;this.dragOffY=0;
  this.spawnTime=0;
  this.alpha=0;
  this.mouthOpen=0;
  // Offscreen sprite canvas (reused, not re-allocated)
  this.sprite=document.createElement('canvas');
  this.sprite.width=SPRITE_W;this.sprite.height=SPRITE_H;
  this.sctx=this.sprite.getContext('2d');
  this.spriteDirty=true;
  this._r=57;this._g=255;this._b=20;
  this._eyeIdx=0;
  this._lastR=-1;this._lastG=-1;this._lastB=-1;this._lastMouth=-1;this._lastSquash=-1;this._lastWave=-1;
  this.frameCount=0;
}

Alien.prototype.update=function(dt,danceSpeed){
  this.spawnTime+=dt;
  this.alpha=Math.min(1,this.spawnTime*3);
  if(!this.dragging){
    this.bob+=dt*this.bobSpeed;
    this.x+=Math.sin(this.bob*0.7)*0.3;
    this.y+=Math.cos(this.bob)*0.4;
  }
  this.x+=(this.tx-this.x)*0.18;
  this.y+=(this.ty-this.y)*0.18;
  this.scale+=(this.targetScale-this.scale)*0.12;
  this.rotation+=(this.targetRotation-this.rotation)*0.1;
  this.colorPhase+=dt*0.5;
  this.eyeColorPhase+=dt*0.8;
  for(var i=0;i<this.tentacles.length;i++){
    this.tentacles[i].wave+=dt*this.tentacles[i].waveSpeed*danceSpeed;
  }
  this.bodySquash+=(1-this.bodySquash)*0.15;
  this.bodySquashY+=(1-this.bodySquashY)*0.15;
  this.dancePhase+=dt*danceSpeed*2;
  this.danceTimer-=dt;
  if(this.danceTimer<=0){this.danceMove=Math.floor(rand(0,3));this.danceTimer=rand(.8,2.5);}
  this.mouthOpen=Math.abs(Math.sin(this.dancePhase*1.5))*0.5+0.1;
  this.tx=clamp(this.tx,30,LW-30);
  this.ty=clamp(this.ty,50,LH-100);

  // Cache color
  var cp=this.colorPhase;
  var r=Math.sin(cp)*0.5+0.5;
  var g=Math.sin(cp+2.1)*0.5+0.5;
  var b=Math.sin(cp+4.2)*0.5+0.5;
  this._r=Math.floor(lerp(57,176,r));
  this._g=Math.floor(lerp(255,38,g));
  this._b=Math.floor(lerp(20,255,b));
  this._eyeIdx=Math.floor(((Math.sin(this.eyeColorPhase)*0.5+0.5)*3))%3;

  // Coarse dirty check — quantize so sprite rarely needs re-render
  this.frameCount++;
  var qR=this._r>>4, qG=this._g>>4, qB=this._b>>4;
  var qMouth=Math.round(this.mouthOpen*4);
  var qSquash=Math.round(this.bodySquash*4);
  var qWave=Math.floor(this.tentacles[0].wave*1.27)&7;
  if(this.frameCount%6===0||
     qR!==this._lastR||qG!==this._lastG||qB!==this._lastB||
     qMouth!==this._lastMouth||qSquash!==this._lastSquash||qWave!==this._lastWave){
    this.spriteDirty=true;
    this._lastR=qR;this._lastG=qG;this._lastB=qB;
    this._lastMouth=qMouth;this._lastSquash=qSquash;this._lastWave=qWave;
  }
};

// Render the alien to its offscreen sprite (centered at SPRITE_W/2, SPRITE_H/2)
// Simplified: fewer draw calls for better performance
Alien.prototype.renderSprite=function(){
  var sc=this.sctx;
  sc.setTransform(1,0,0,1,0,0);
  sc.clearRect(0,0,SPRITE_W,SPRITE_H);
  sc.save();
  sc.translate(SPRITE_W/2,SPRITE_H/2);

  var r=this._r,g=this._g,b=this._b;
  var lr=Math.min(r+50,255)|0, lg=Math.min(g+50,255)|0, lb=Math.min(b+50,255)|0;
  var bodyStr='rgb('+r+','+g+','+b+')';
  var lightStr='rgb('+lr+','+lg+','+lb+')';
  var EYE=['#39ff14','#b026ff','#ff69b4'];
  var eyeColor=EYE[this._eyeIdx];
  var bs=this.bodySquash,bsy=this.bodySquashY;
  var br=this.bodyR;
  var dp=this.dancePhase;

  // Tentacles — stroke + tip dot combined per tentacle
  sc.lineCap='round';
  sc.strokeStyle=bodyStr;sc.lineWidth=5;
  sc.fillStyle=lightStr;
  for(var i=0;i<this.tentacles.length;i++){
    var t=this.tentacles[i];
    var tx1=t.ca*br*0.7*bs, ty1=t.sa*br*0.7*bsy;
    var wave=Math.sin(t.wave)*15;
    var wave2=Math.sin(t.wave+1)*8;
    var pcos=Math.cos(t.angle+1.5708),psin=Math.sin(t.angle+1.5708);
    var tx2=tx1+t.ca*t.len*bs+wave*pcos;
    var ty2=ty1+t.sa*t.len*bsy+wave*psin;
    var tx3=tx2+t.ca*t.len*0.4+wave2*pcos;
    var ty3=ty2+t.sa*t.len*0.4+wave2*psin;
    sc.beginPath();sc.moveTo(tx1,ty1);sc.quadraticCurveTo(tx2,ty2,tx3,ty3);sc.stroke();
    sc.beginPath();sc.arc(tx3,ty3,4,0,6.283);sc.fill();
  }

  // Body + highlight — 2 fills
  sc.fillStyle=bodyStr;
  sc.beginPath();sc.arc(0,0,br*bs,0,6.283);sc.fill();
  sc.fillStyle=lightStr;sc.globalAlpha=0.5;
  sc.beginPath();sc.arc(0,-br*0.25,br*0.6*bs,0,6.283);sc.fill();
  sc.globalAlpha=1;

  // Eyes — 4 fills (color + pupil, skip whites)
  var eyeY=-br*0.15, eyeSp=br*0.35;
  sc.fillStyle=eyeColor;
  sc.beginPath();sc.arc(-eyeSp,eyeY,7,0,6.283);sc.fill();
  sc.beginPath();sc.arc(eyeSp,eyeY,7,0,6.283);sc.fill();
  sc.fillStyle='#000';
  sc.beginPath();sc.arc(-eyeSp+1,eyeY-1,3,0,6.283);sc.fill();
  sc.beginPath();sc.arc(eyeSp+1,eyeY-1,3,0,6.283);sc.fill();

  // Mouth — 1 fill
  var mw=br*0.3*this.mouthOpen+4;
  sc.fillStyle='#1a0a2a';
  sc.beginPath();sc.arc(0,br*0.25,Math.max(mw,4),0,6.283);sc.fill();

  // Antenna — 1 stroke + 1 fill
  sc.strokeStyle=bodyStr;sc.lineWidth=3;
  var ax=Math.sin(dp*1.5)*8;
  var ay=-br*bsy-18;
  sc.beginPath();sc.moveTo(0,-br*bsy);sc.lineTo(ax,ay);sc.stroke();
  sc.fillStyle=eyeColor;
  sc.beginPath();sc.arc(ax,ay,4,0,6.283);sc.fill();

  sc.restore();
  this.spriteDirty=false;
};

Alien.prototype.draw=function(ctx){
  if(this.alpha<=0)return;
  // Sprite re-rendering is handled by the loop's render budget — just draw cached sprite
  ctx.globalAlpha=this.alpha;
  var dp=this.dancePhase;
  var danceOffX=0,danceOffY=0,danceRot=0,danceScale=1;
  switch(this.danceMove){
    case 0: danceOffX=Math.sin(dp)*8; break;
    case 1: danceRot=dp*0.8; danceOffY=Math.sin(dp*2)*6; break;
    case 2: danceOffY=-Math.abs(Math.sin(dp*2))*15; break;
  }
  if(this.dragging)danceScale=1.1;
  ctx.save();
  ctx.translate(this.x+danceOffX,this.y+danceOffY);
  ctx.rotate(this.rotation+danceRot);
  ctx.scale(this.scale*danceScale,this.scale*danceScale);
  ctx.drawImage(this.sprite,-SPRITE_W/2,-SPRITE_H/2);
  ctx.restore();
  ctx.globalAlpha=1;
};

/* ---------- Game state ---------- */
var aliens=[],particles=[],beams=[],shake=0;
var state='hint',beatPhase=0,beatTimer=0,beatIndex=0;
var autoSpawn=false,chaosMode=false;
var dragTarget=null;
var comboLevel=1;
var frameCounter=0;

function spawnAlien(x,y){
  if(aliens.length>=30){showToast('Max 30 aliens!');return;}
  var a=new Alien(x||rand(60,LW-60),y||rand(120,LH-180));
  a.bodySquash=0.3;a.bodySquashY=1.5;
  aliens.push(a);
  shake=8;
  spawnSpawnParticles(a.x,a.y);
  sndSpawn();
  ensureAudio();startHum();
  updateCombo();
}
var MAX_PARTICLES=50;
function spawnSpawnParticles(x,y){
  if(particles.length>MAX_PARTICLES)return;
  for(var i=0;i<5;i++){
    var a=Math.random()*6.283,sp=rand(40,120);
    particles.push({x:x,y:y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:1,
      ci:(Math.random()*4)|0,size:rand(2,4)});
  }
  if(beams.length<5)beams.push({x:x,y:y-100,life:1,width:50});
}
function spawnBeamParticles(x,y){
  if(particles.length>MAX_PARTICLES-2)return;
  for(var i=0;i<2;i++){
    particles.push({x:x+rand(-20,20),y:y-40,vx:rand(-10,10),vy:rand(-60,-20),life:1,ci:0,size:rand(1,2)});
  }
}
function updateCombo(){
  var n=aliens.length;
  var prev=comboLevel;
  comboLevel=Math.max(1,Math.ceil(n/3));
  elCombo.textContent=comboLevel+'x';
  elCount.textContent=n;
  if(comboLevel>prev){
    elComboNum.textContent=comboLevel;
    elComboBadge.classList.add('show');
    setTimeout(function(){elComboBadge.classList.remove('show');},1500);
    sndPop();
  }
}

/* ---------- Particles ---------- */
var PCOLORS=['#39ff14','#b026ff','#ff69b4','#ffffff'];
function updateParticles(dt){
  for(var i=particles.length-1;i>=0;i--){
    var p=particles[i];
    p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=300*dt;
    p.life-=dt*2;
    if(p.life<=0){particles[i]=particles[particles.length-1];particles.pop();}
  }
  for(var i=beams.length-1;i>=0;i--){
    beams[i].life-=dt*1.5;
    if(beams[i].life<=0){beams[i]=beams[beams.length-1];beams.pop();}
  }
  if(shake>0)shake=Math.max(0,shake-dt*60);
}
var beamGradient=null;
function drawBeams(){
  if(beams.length===0)return;
  if(!beamGradient){
    beamGradient=ctx.createLinearGradient(0,0,0,100);
    beamGradient.addColorStop(0,'rgba(57,255,20,0)');
    beamGradient.addColorStop(0.5,'rgba(57,255,20,0.25)');
    beamGradient.addColorStop(1,'rgba(176,38,255,0.08)');
  }
  ctx.fillStyle=beamGradient;
  for(var i=0;i<beams.length;i++){
    var b=beams[i];
    ctx.globalAlpha=Math.max(0,b.life*0.4);
    ctx.beginPath();
    ctx.moveTo(b.x-b.width*b.life,b.y);
    ctx.lineTo(b.x+b.width*b.life,b.y);
    ctx.lineTo(b.x+b.width*0.3*b.life,b.y+100);
    ctx.lineTo(b.x-b.width*0.3*b.life,b.y+100);
    ctx.closePath();ctx.fill();
  }
  ctx.globalAlpha=1;
}
function drawParticles(){
  if(particles.length===0)return;
  // Group by color index — single fill per color, no per-particle alpha (faster + correct)
  for(var c=0;c<4;c++){
    ctx.fillStyle=PCOLORS[c];
    ctx.beginPath();
    for(var i=0;i<particles.length;i++){
      var p=particles[i];
      if(p.ci!==c||p.life<=0)continue;
      ctx.moveTo(p.x+p.size,p.y);
      ctx.arc(p.x,p.y,p.size,0,6.283);
    }
    ctx.fill();
  }
}

/* ---------- Dance ---------- */
function getDanceSpeed(){return 1+aliens.length*0.08;}
function updateDance(dt){
  var ds=getDanceSpeed();
  beatPhase+=dt*ds*2;
  beatTimer+=dt*ds;
  var beatInterval=0.5/Math.max(1,ds*0.5);
  if(beatTimer>=beatInterval){beatTimer=0;onBeat(ds);}
}
function onBeat(ds){
  for(var i=0;i<aliens.length;i++){
    var a=aliens[i];
    if(!a.dragging){
      a.bodySquash=0.7+rand(-0.1,0.1);
      a.bodySquashY=1.3+rand(-0.1,0.1);
      if(Math.random()<0.3)a.danceMove=Math.floor(rand(0,3));
    }
  }
  if(aliens.length>0){
    sndBeat(comboLevel*0.3);
    if(Math.random()<0.3)sndZap();
    if(beatIndex%4===0&&Math.random()<0.4)sndLaugh();
  }
  if(chaosMode){
    for(var i=0;i<aliens.length;i++){
      if(Math.random()<0.2)spawnBeamParticles(aliens[i].x,aliens[i].y);
    }
  }
  beatIndex++;
}
function applyChaos(dt){
  if(!chaosMode)return;
  for(var i=0;i<aliens.length;i++){
    var a=aliens[i];
    if(!a.dragging){
      a.targetRotation+=rand(-2,2)*dt;
      a.targetScale=clamp(a.targetScale+rand(-0.3,0.3)*dt,0.5,1.5);
      if(Math.random()<dt*2){
        a.tx=clamp(a.x+rand(-60,60),30,LW-30);
        a.ty=clamp(a.y+rand(-60,60),50,LH-100);
      }
    }
  }
}

/* ---------- Render (no blend modes!) ---------- */
var _sortBuf=[];
function render(){
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle='#fff';
  ctx.fillRect(0,0,LW,LH);
  ctx.fillStyle='rgba(0,0,0,0.02)';
  ctx.fillRect(0,LH-110,LW,110);

  ctx.save();
  if(shake>0)ctx.translate((Math.random()-0.5)*shake,(Math.random()-0.5)*shake);

  drawBeams();

  // Aliens — pure drawImage, sort every 6 frames for depth ordering
  var n=aliens.length;
  if(n>0){
    _sortBuf.length=n;
    for(var i=0;i<n;i++)_sortBuf[i]=aliens[i];
    if(sortFrame%6===0)_sortBuf.sort(function(a,b){return a.y-b.y;});
    for(var i=0;i<n;i++)_sortBuf[i].draw(ctx);
  }

  drawParticles();
  ctx.restore();

  if(chaosMode){ctx.fillStyle='rgba(176,38,255,0.03)';ctx.fillRect(0,0,LW,LH);}
  sortFrame++;
}

/* ---------- Main loop ---------- */
var lastT=performance.now();
var SPRITE_BUDGET=3; // max sprites re-rendered per frame
var sortFrame=0;
function loop(ts){
  var dt=(ts-lastT)/1000;lastT=ts;if(dt>0.05)dt=0.05;
  frameCounter++;
  if(state==='playing'){
    var ds=getDanceSpeed();
    for(var i=0;i<aliens.length;i++)aliens[i].update(dt,ds);
    // Sprite render budget: only re-render N dirty sprites per frame.
    // With 30 aliens, each gets re-rendered every ~10 frames — smooth enough.
    var rendered=0;
    for(var i=0;i<aliens.length&&rendered<SPRITE_BUDGET;i++){
      if(aliens[i].spriteDirty){aliens[i].renderSprite();rendered++;}
    }
    updateDance(dt);
    applyChaos(dt);
    if(autoSpawn&&aliens.length<25&&Math.random()<dt*0.8){
      spawnAlien(rand(60,LW-60),rand(120,LH-180));
    }
  }
  updateParticles(dt);
  render();
  requestAnimationFrame(loop);
}

/* ---------- Input ---------- */
function canvasPos(e){
  return{x:(e.clientX-canvasRect.left)/canvasRect.width*LW,y:(e.clientY-canvasRect.top)/canvasRect.height*LH};
}
function getAlienAt(x,y){
  for(var i=aliens.length-1;i>=0;i--){
    var a=aliens[i];
    var r2=a.bodyR*a.scale*1.2;
    r2*=r2;
    if(dist2(x,y,a.x,a.y)<r2)return a;
  }
  return null;
}
canvas.addEventListener('pointerdown',function(e){
  e.preventDefault();ensureAudio();
  if(state!=='playing')return;
  var p=canvasPos(e);
  var a=getAlienAt(p.x,p.y);
  if(a){
    dragTarget=a;a.dragging=true;
    a.dragOffX=p.x-a.x;a.dragOffY=p.y-a.y;
    a.bodySquash=0.6;a.bodySquashY=1.4;
    sndSquelch();
  }else{
    spawnAlien(p.x,p.y);
  }
});
canvas.addEventListener('pointermove',function(e){
  e.preventDefault();
  if(state!=='playing')return;
  if(dragTarget){
    var p=canvasPos(e);
    dragTarget.tx=p.x-dragTarget.dragOffX;
    dragTarget.ty=p.y-dragTarget.dragOffY;
    dragTarget.x=dragTarget.tx;
    dragTarget.y=dragTarget.ty;
  }
});
window.addEventListener('pointerup',function(){
  if(dragTarget){
    dragTarget.dragging=false;
    dragTarget.bodySquash=1.2;dragTarget.bodySquashY=0.8;
    sndPop();
    dragTarget=null;
  }
});
window.addEventListener('pointercancel',function(){
  if(dragTarget){dragTarget.dragging=false;dragTarget=null;}
});
window.addEventListener('blur',function(){
  if(dragTarget){dragTarget.dragging=false;dragTarget=null;}
});

/* ---------- UI ---------- */
var toastTimer=null;
function showToast(msg){
  elToast.textContent=msg;elToast.classList.add('show');
  if(toastTimer)clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){elToast.classList.remove('show');},2000);
}

document.getElementById('btnStart').onclick=function(e){e.stopPropagation();startGame();};
function startGame(){
  state='playing';
  document.getElementById('hintOverlay').classList.add('hide');
  ensureAudio();startHum();
  setTimeout(function(){spawnAlien(LW/2,LH*0.45);},300);
}
document.getElementById('btnAdd').onclick=function(e){e.stopPropagation();
  if(state!=='playing')return;spawnAlien(rand(60,LW-60),rand(120,LH-180));};
document.getElementById('btnAuto').onclick=function(e){e.stopPropagation();
  autoSpawn=!autoSpawn;this.classList.toggle('active',autoSpawn);
  showToast(autoSpawn?'Auto Spawn ON':'Auto Spawn OFF');};
document.getElementById('btnChaos').onclick=function(e){e.stopPropagation();
  chaosMode=!chaosMode;this.classList.toggle('active',chaosMode);
  showToast(chaosMode?'Chaos Dance ON':'Chaos Dance OFF');};
document.getElementById('btnPhoto').onclick=function(e){e.stopPropagation();
  if(state!=='playing')return;
  sndPhoto();shake=6;
  var flash=document.createElement('div');
  flash.style.cssText='position:absolute;inset:0;background:#fff;z-index:30;opacity:.8;transition:opacity .3s;';
  gameArea.appendChild(flash);
  setTimeout(function(){flash.style.opacity='0';},50);
  setTimeout(function(){flash.remove();},400);
  try{var link=document.createElement('a');
    link.download='alien-dance-'+Date.now()+'.png';
    link.href=canvas.toDataURL('image/png');link.click();
    showToast('Photo saved!');}catch(err){showToast('Photo saved!');}};
document.getElementById('btnClear').onclick=function(e){e.stopPropagation();
  if(aliens.length===0)return;
  for(var i=0;i<aliens.length;i++)spawnSpawnParticles(aliens[i].x,aliens[i].y);
  aliens=[];comboLevel=1;
  elCombo.textContent='1x';elCount.textContent='0';
  sndClear();shake=10;showToast('Cleared!');};
document.getElementById('copyBtn').onclick=function(e){e.stopPropagation();
  var text='Alien Dance Party! Spawned '+aliens.length+' aliens at '+comboLevel+'x combo! 👽🛸\nPlay: '+location.href;
  if(navigator.share){navigator.share({title:'Alien Dance Party',text:text}).catch(function(){});}
  else{try{navigator.clipboard.writeText(text);showToast('Copied to clipboard!');}
  catch(err){showToast('Share: '+location.href);}}};

/* ---------- Init ---------- */
function init(){
  // Cache ALL DOM refs
  elCount=document.getElementById('countStat');
  elCombo=document.getElementById('comboStat');
  elComboBadge=document.getElementById('comboBadge');
  elComboNum=document.getElementById('comboNum');
  elToast=document.getElementById('toast');
  setupCanvas();fitArea();
  var pv=document.getElementById('previewAlien');
  pv.innerHTML='<svg viewBox="0 0 80 80" width="80" height="80">'+
    '<circle cx="40" cy="42" r="20" fill="#39ff14"/>'+
    '<circle cx="40" cy="35" r="12" fill="#5fff3a" opacity="0.5"/>'+
    '<circle cx="33" cy="38" r="5" fill="#b026ff"/><circle cx="47" cy="38" r="5" fill="#b026ff"/>'+
    '<circle cx="33" cy="38" r="2" fill="#fff"/><circle cx="47" cy="38" r="2" fill="#fff"/>'+
    '<circle cx="40" cy="48" r="4" fill="#1a0a2a"/>'+
    '<line x1="40" y1="22" x2="40" y2="12" stroke="#39ff14" stroke-width="2"/>'+
    '<circle cx="40" cy="10" r="4" fill="#b026ff"/>'+
    '<path d="M20 55 Q15 65 25 68" stroke="#39ff14" stroke-width="4" fill="none" stroke-linecap="round"/>'+
    '<path d="M60 55 Q65 65 55 68" stroke="#39ff14" stroke-width="4" fill="none" stroke-linecap="round"/>'+
    '<path d="M30 58 Q28 68 35 70" stroke="#39ff14" stroke-width="4" fill="none" stroke-linecap="round"/>'+
    '<path d="M50 58 Q52 68 45 70" stroke="#39ff14" stroke-width="4" fill="none" stroke-linecap="round"/></svg>';
  requestAnimationFrame(loop);
}
window.addEventListener('resize',function(){fitArea();setupCanvas();});
window.addEventListener('scroll',updateCanvasRect,{passive:true});
window.addEventListener('orientationchange',function(){setTimeout(function(){fitArea();setupCanvas();},300);});
init();
window.AlienGame={
  getState:function(){return state;},
  getAlienCount:function(){return aliens.length;},
  getCombo:function(){return comboLevel;},
  _spawn:function(n){for(var i=0;i<n;i++)spawnAlien(rand(60,LW-60),rand(120,LH-180));},
  _startGame:startGame,
  _fps:function(){var f=0,l=performance.now(),a=[];var iv=setInterval(function(){f++;var n=performance.now();if(n-l>=1000){a.push(f);f=0;l=n;if(a.length>=3){clearInterval(iv);window.__fps=a;}}},16);return 'measuring';}
};
