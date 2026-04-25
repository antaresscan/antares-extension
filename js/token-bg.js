;(()=>{
  const C=document.getElementById("bg")
  const ctx=C.getContext("2d")
  let W,H,pts=[]
  const N=60,CONN=140,SPEED=.35
  function resize(){W=C.width=window.innerWidth;H=C.height=window.innerHeight}
  resize();window.addEventListener("resize",resize)
  for(let i=0;i<N;i++)pts.push({x:Math.random()*1400,y:Math.random()*900,vx:(Math.random()-.5)*SPEED,vy:(Math.random()-.5)*SPEED,r:Math.random()*1.5+.5})
  const riskColors={
    safe:'rgba(0,229,176,.18)',
    caution:'rgba(245,208,0,.18)',
    danger:'rgba(255,95,95,.18)',
    rug:'rgba(255,34,68,.2)'
  }
  const riskLineColors={
    safe:  (a)=>`rgba(0,229,176,${a})`,
    caution:(a)=>`rgba(245,208,0,${a})`,
    danger: (a)=>`rgba(255,95,95,${a})`,
    rug:    (a)=>`rgba(255,34,68,${a})`
  }
  function draw(){
    const rc=window.__riskClass||'safe'
    const dotColor=riskColors[rc]||riskColors.safe
    const lineColor=riskLineColors[rc]||riskLineColors.safe
    ctx.clearRect(0,0,W,H)
    for(const p of pts){
      p.x+=p.vx;p.y+=p.vy
      if(p.x<0||p.x>W)p.vx*=-1
      if(p.y<0||p.y>H)p.vy*=-1
      ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2)
      ctx.fillStyle=dotColor;ctx.fill()
    }
    for(let i=0;i<pts.length;i++){const p=pts[i];for(let j=i+1;j<pts.length;j++){const q=pts[j];const d2=(p.x-q.x)**2+(p.y-q.y)**2;if(d2>CONN*CONN)continue;ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.strokeStyle=lineColor(0.08*(1-d2/(CONN*CONN)));ctx.stroke()}}
    requestAnimationFrame(draw)
  }
  draw()
})()
