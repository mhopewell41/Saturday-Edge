const LIVE_ENDPOINT = "https://ahskdtpxsjqasbpbvxja.supabase.co/functions/v1/saturday-edge-board";
const PERFORMANCE_ENDPOINT = "https://ahskdtpxsjqasbpbvxja.supabase.co/functions/v1/saturday-edge-performance";
const SETTINGS_VERSION = 6;

const DEMO_GAMES = [
  {
    id:"demo-1", kickoff:"2026-09-12T15:30:00-04:00",
    away:"Demo State", home:"Saturday Tech",
    recommendedTeam:"Demo State", marketLine:7.5, marketPrice:-110,
    projectedLine:3.5, edge:4.0, edgeScore:76, classification:"PLAYABLE",
    eligibleForRecommendation:true, matchedSystems:["SP+","FPI"], dataQuality:.68,
    marketConsensus:{available:true, consensusLine:7.0, bookCount:8, betmgmVsConsensus:.5, signal:"BETMGM_BETTER"},
    factors:[
      {type:"good",text:"Demo model projects Demo State +3.5 versus BetMGM +7.5, creating a 4.0-point model edge."},
      {type:"good",text:"BetMGM is 0.5 points better than the broader market for this side."},
      {type:"info",text:"Demo mode does not place or recommend a real wager."}
    ]
  }
];

const defaultSettings = { version:SETTINGS_VERSION, mode:"live", endpoint:LIVE_ENDPOINT };

function loadSettings(){
  try{
    const saved = JSON.parse(localStorage.getItem("se-settings") || "{}");
    if(saved.version !== SETTINGS_VERSION){
      localStorage.setItem("se-settings", JSON.stringify(defaultSettings));
      return {...defaultSettings};
    }
    return {...defaultSettings, ...saved};
  }catch{ return {...defaultSettings}; }
}

let settings = loadSettings();
let games = [];
let currentFilter = "ALL";
let currentBetGame = null;
let lastPayload = null;
let performance = null;

const $ = id => document.getElementById(id);
const fmtLine = n => n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : `${Number(n)>0?"+":""}${Number(n).toFixed(1)}`;
const fmtPrice = n => Number(n)>0 ? `+${Number(n)}` : `${Number(n)}`;
const fmtTime = iso => new Intl.DateTimeFormat("en-US",{weekday:"short",hour:"numeric",minute:"2-digit"}).format(new Date(iso));
const fmtUnits = n => n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : `${Number(n)>=0?"+":""}${Number(n).toFixed(2)}u`;
const fmtPct = n => n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : `${Number(n).toFixed(1)}%`;
const record = s => s ? `${s.wins||0}-${s.losses||0}${s.pushes ? `-${s.pushes}` : ""}` : "—";

function marketChip(g){
  const m=g.marketConsensus;
  if(!m?.available) return `<span class="market-chip neutral">Market: limited</span>`;
  const v=Number(m.betmgmVsConsensus||0);
  if(v>=1) return `<span class="market-chip good">💎 BetMGM +${v.toFixed(1)} better</span>`;
  if(v>=.5) return `<span class="market-chip good">✓ BetMGM +${v.toFixed(1)} better</span>`;
  if(v<=-1) return `<span class="market-chip bad">⚠ BetMGM ${Math.abs(v).toFixed(1)} worse</span>`;
  if(v<=-.5) return `<span class="market-chip caution">BetMGM ${Math.abs(v).toFixed(1)} worse</span>`;
  return `<span class="market-chip neutral">Market aligned</span>`;
}

function movementFor(g){ return performance?.movementByGame?.[g.id] || null; }

function movementChip(g){
  const m=movementFor(g);
  if(!m || m.firstLine===null || m.currentLine===null) return "";
  if(Number(m.snapshots||0)<=1) return `<span class="movement-chip neutral">📍 First look ${fmtLine(m.currentLine)}</span>`;
  const change=Number(m.lineChange||0);
  const cls=Math.abs(change)<.01?"neutral":"active";
  return `<span class="movement-chip ${cls}">📈 First ${fmtLine(m.firstLine)} → Now ${fmtLine(m.currentLine)} <small>${m.snapshots} snaps</small></span>`;
}

const LIVE_CACHE_KEY="se-live-board-cache-v06";
const LIVE_CACHE_TTL_MS=5*60*1000;

function readLiveCache(){
  try{
    const raw=localStorage.getItem(LIVE_CACHE_KEY); if(!raw) return null;
    const cached=JSON.parse(raw); if(!cached?.savedAt||!cached?.payload) return null;
    return cached;
  }catch{return null;}
}
function writeLiveCache(payload){ try{localStorage.setItem(LIVE_CACHE_KEY,JSON.stringify({savedAt:Date.now(),payload}));}catch{} }

async function loadGames(){
  $("refreshBtn").disabled=true;
  $("statusText").textContent=settings.mode==="live"?"Loading BetMGM spread board…":"Demo mode is active.";
  try{
    if(settings.mode==="live"){
      if(!settings.endpoint) throw new Error("Add the Supabase Edge Function URL in Settings.");
      const cached=readLiveCache();
      const cacheAge=cached?Date.now()-cached.savedAt:Infinity;
      let payload=null, source="live";
      if(cached&&cacheAge<LIVE_CACHE_TTL_MS){ payload=cached.payload; source="cache"; }
      else{
        const r=await fetch(settings.endpoint,{headers:{Accept:"application/json"},cache:"no-store"});
        payload=await r.json().catch(()=>({}));
        if(!r.ok) throw new Error(payload.error||`Live data request failed (${r.status}).`);
        if(payload.error) throw new Error(payload.error);
        writeLiveCache(payload);
      }
      lastPayload=payload;
      games=Array.isArray(payload.games)?payload.games:[];
      const credits=payload.oddsApiUsage?.remaining;
      const creditText=credits!==null&&credits!==undefined?` • ${credits} odds credits left`:"";
      const ageText=source==="cache"?` • cached ${Math.max(0,Math.floor(cacheAge/1000))}s ago`:" • fresh pull";
      $("statusText").textContent=`Live board • ${payload.modelVersion||"model"} • ${games.length} games${ageText}${creditText}`;
    }else{
      lastPayload=null; games=DEMO_GAMES;
      $("statusText").textContent="Demo mode • no live API usage";
    }
  }catch(err){
    console.error(err); games=DEMO_GAMES; lastPayload=null;
    $("statusText").textContent=`${err.message} Showing demo board instead.`;
  }finally{
    $("refreshBtn").disabled=false; render();
  }
}

async function loadPerformance(){
  if(settings.mode!=="live"){
    performance=null;
    $("performanceStatus").textContent="Performance receipts are available in live mode.";
    renderPerformance();
    return;
  }
  try{
    const r=await fetch(PERFORMANCE_ENDPOINT,{headers:{Accept:"application/json"},cache:"no-store"});
    const payload=await r.json().catch(()=>({}));
    if(!r.ok||payload.error) throw new Error(payload.error||`Performance request failed (${r.status}).`);
    performance=payload;
    const generated=payload.generatedAt?new Date(payload.generatedAt).toLocaleString():"now";
    $("performanceStatus").textContent=`Actionable bankroll = PLAYABLE + STRONG • refreshed ${generated}`;
  }catch(err){
    console.error(err); performance=null;
    $("performanceStatus").textContent=`Performance feed unavailable: ${err.message}`;
  }
  renderPerformance(); render();
}

function renderPerformance(){
  const a=performance?.actionable;
  if(!a){
    $("performanceGrid").innerHTML=`
      <article class="performance-card hero-metric"><span>Actionable ATS</span><strong>—</strong><small>PLAYABLE + STRONG</small></article>
      <article class="performance-card"><span>Units</span><strong>—</strong><small>No research units counted</small></article>
      <article class="performance-card"><span>Avg CLV</span><strong>—</strong><small>First actionable vs close</small></article>
      <article class="performance-card"><span>ROI</span><strong>—</strong><small>Prospective sample</small></article>`;
    $("performanceBreakdown").innerHTML="";
    $("recentResults").innerHTML="";
    return;
  }

  $("performanceGrid").innerHTML=`
    <article class="performance-card hero-metric"><span>Actionable ATS</span><strong>${record(a)}</strong><small>${fmtPct(a.atsWinRate)} • ${a.gradedGames||0} graded</small></article>
    <article class="performance-card"><span>Units</span><strong class="${Number(a.unitsProfit||0)>=0?"positive":"negative"}">${fmtUnits(a.unitsProfit)}</strong><small>1u risk per graded play</small></article>
    <article class="performance-card"><span>Avg CLV</span><strong>${a.avgClv===null?"—":`${Number(a.avgClv)>=0?"+":""}${Number(a.avgClv).toFixed(2)}`}</strong><small>points vs observed close</small></article>
    <article class="performance-card"><span>ROI</span><strong>${fmtPct(a.roi)}</strong><small>Prospective actionable sample</small></article>`;

  const b=performance.byClassification||{};
  $("performanceBreakdown").innerHTML=["STRONG","PLAYABLE","LEAN","PASS"].map(c=>{
    const s=b[c]||{};
    const actionable=s.accounting==="ACTIONABLE";
    return `<article class="split-card ${actionable?"actionable":"research"}">
      <div><span class="badge ${c}">${badgeText(c)}</span><small>${actionable?"BANKROLL":"RESEARCH ONLY"}</small></div>
      <strong>${record(s)}</strong>
      <span>${fmtPct(s.atsWinRate)} ATS • ${s.gradedGames||0} graded</span>
      <span>${actionable?`${fmtUnits(s.unitsProfit)} • CLV ${s.avgClv===null?"—":Number(s.avgClv).toFixed(2)}`:"No units counted"}</span>
    </article>`;
  }).join("");

  const recent=performance.recent||[];
  if(!recent.length){
    $("recentResults").innerHTML=`<div class="empty compact">No completed prospective games graded yet.</div>`;
    return;
  }
  $("recentResults").innerHTML=`<div class="recent-heading"><strong>Latest graded games</strong><span>Research rows are intentionally excluded from bankroll units.</span></div>
    <div class="table-wrap"><table class="bets-table performance-table">
      <thead><tr><th>Game</th><th>Side</th><th>Class</th><th>Final</th><th>ATS</th><th>Margin</th><th>Units</th><th>CLV</th></tr></thead>
      <tbody>${recent.map(r=>`<tr>
        <td>${escapeHtml(r.away)} @ ${escapeHtml(r.home)}</td>
        <td>${escapeHtml(r.recommendedTeam)} ${fmtLine(r.line)}</td>
        <td>${escapeHtml(r.classification||"—")}</td>
        <td>${r.awayScore}-${r.homeScore}</td>
        <td><span class="result-pill ${(r.atsResult||"").toLowerCase()}">${escapeHtml(r.atsResult||"—")}</span></td>
        <td>${r.atsMargin===null?"—":`${Number(r.atsMargin)>=0?"+":""}${Number(r.atsMargin).toFixed(1)}`}</td>
        <td>${r.accounting==="ACTIONABLE"?fmtUnits(r.unitsProfit):"Research"}</td>
        <td>${r.clv===null?"—":`${Number(r.clv)>=0?"+":""}${Number(r.clv).toFixed(1)}`}</td>
      </tr>`).join("")}</tbody>
    </table></div>`;
}

function render(){
  const sort=$("sortSelect").value;
  let shown=games.filter(g=>currentFilter==="ALL"||g.classification===currentFilter);
  shown.sort((a,b)=>{
    if(sort==="time") return new Date(a.kickoff)-new Date(b.kickoff);
    if(sort==="score") return Number(b.edgeScore||0)-Number(a.edgeScore||0);
    return Math.abs(Number(b.edge||0))-Math.abs(Number(a.edge||0));
  });

  $("board").innerHTML=shown.map(g=>{
    const consensus=g.marketConsensus?.available?fmtLine(g.marketConsensus.consensusLine):"—";
    const systems=Array.isArray(g.matchedSystems)?g.matchedSystems.join(" + "):"—";
    return `<article class="game-card">
      <div class="matchup">
        <strong>${escapeHtml(g.away)} @ ${escapeHtml(g.home)}</strong>
        <span>${fmtTime(g.kickoff)} • BetMGM ${fmtPrice(g.marketPrice??-110)} • Models: ${escapeHtml(systems)}</span>
        <div class="market-row">${marketChip(g)} <span class="consensus-text">Consensus ${consensus}${g.marketConsensus?.bookCount?` (${g.marketConsensus.bookCount} books)`:""}</span>${movementChip(g)}</div>
      </div>
      <div class="metric"><label>Best side</label><strong>${escapeHtml(g.recommendedTeam)}</strong></div>
      <div class="metric"><label>BetMGM</label><strong>${fmtLine(g.marketLine)}</strong></div>
      <div class="metric"><label>Our line</label><strong>${fmtLine(g.projectedLine)}</strong></div>
      <div class="metric"><label>Edge</label><strong class="edge-positive">+${Math.abs(Number(g.edge||0)).toFixed(1)}</strong></div>
      <div class="rating"><span class="badge ${escapeHtml(g.classification)}">${badgeText(g.classification)} ${Math.round(Number(g.edgeScore||0))}</span></div>
      <div class="card-actions"><button class="small-btn" onclick="openWhy('${g.id}')">WHY?</button><button class="small-btn bet" onclick="openBet('${g.id}')">+ Track</button></div>
    </article>`;
  }).join("");

  $("emptyState").classList.toggle("hidden",shown.length>0);
  $("gamesCount").textContent=games.length;
  $("passCount").textContent=games.filter(g=>g.classification==="PASS").length;
  $("playableCount").textContent=games.filter(g=>g.classification==="PLAYABLE").length;
  $("strongCount").textContent=games.filter(g=>g.classification==="STRONG").length;
  renderBets();
}

function badgeText(c){ return ({STRONG:"🔥 STRONG",PLAYABLE:"🟢 PLAYABLE",LEAN:"🟡 LEAN",PASS:"🔴 PASS"})[c]||c; }

function openWhy(id){
  const g=games.find(x=>x.id===id); if(!g) return;
  const m=g.marketConsensus||{};
  const move=movementFor(g);
  const systems=Array.isArray(g.matchedSystems)&&g.matchedSystems.length?g.matchedSystems.join(", "):"None";
  const movementStats=move?`
    <div class="why-stat"><span>First recorded line</span><strong>${fmtLine(move.firstLine)}</strong></div>
    <div class="why-stat"><span>Latest recorded line</span><strong>${fmtLine(move.currentLine)}</strong></div>
    <div class="why-stat"><span>Evidence snapshots</span><strong>${move.snapshots}</strong></div>`:"";
  $("dialogTitle").textContent=`${g.away} @ ${g.home}`;
  $("dialogBody").innerHTML=`<div class="why-grid">
    <div class="why-stat"><span>Recommended side</span><strong>${escapeHtml(g.recommendedTeam)} ${fmtLine(g.marketLine)}</strong></div>
    <div class="why-stat"><span>Our projected line</span><strong>${fmtLine(g.projectedLine)}</strong></div>
    <div class="why-stat"><span>Model edge</span><strong class="edge-positive">+${Math.abs(Number(g.edge||0)).toFixed(1)} pts</strong></div>
    <div class="why-stat"><span>Market consensus</span><strong>${m.available?fmtLine(m.consensusLine):"Unavailable"}</strong></div>
    <div class="why-stat"><span>BetMGM vs market</span><strong>${m.available?`${Number(m.betmgmVsConsensus||0)>=0?"+":""}${Number(m.betmgmVsConsensus||0).toFixed(1)} pts`:"—"}</strong></div>
    <div class="why-stat"><span>Rating systems</span><strong>${escapeHtml(systems)}</strong></div>${movementStats}
  </div>
  <div class="reason-list">${(g.factors||[]).map(f=>`<div class="reason ${f.type||"info"}">${escapeHtml(f.text)}</div>`).join("")}</div>`;
  $("gameDialog").showModal();
}
window.openWhy=openWhy;

function openBet(id){
  const g=games.find(x=>x.id===id); if(!g) return;
  currentBetGame=g; $("betGameId").value=g.id;
  $("betDialogTitle").textContent=`${g.recommendedTeam} ${fmtLine(g.marketLine)}`;
  $("betLine").value=Number(g.marketLine).toFixed(1); $("betPrice").value=g.marketPrice??-110;
  $("betUnits").value="1"; $("betNotes").value=""; $("betDialog").showModal();
}
window.openBet=openBet;

function getBets(){ try{return JSON.parse(localStorage.getItem("se-bets")||"[]");}catch{return [];} }
function saveBets(bets){localStorage.setItem("se-bets",JSON.stringify(bets));renderBets();}
function renderBets(){
  const bets=getBets(); $("betCount").textContent=bets.length;
  $("unitsRisked").textContent=`${bets.reduce((s,b)=>s+Number(b.units||0),0).toFixed(1)}u`;
  if(!bets.length){$("betsTableWrap").innerHTML=`<div class="empty">No bets tracked yet. Use “+ Track” on a game card.</div>`;return;}
  $("betsTableWrap").innerHTML=`<table class="bets-table"><thead><tr><th>Date</th><th>Game</th><th>Side</th><th>Line</th><th>Price</th><th>Units</th><th>Edge</th><th>MGM vs Mkt</th><th></th></tr></thead><tbody>${bets.map((b,i)=>`<tr>
    <td>${new Date(b.createdAt).toLocaleDateString()}</td><td>${escapeHtml(b.away)} @ ${escapeHtml(b.home)}</td><td>${escapeHtml(b.team)}</td><td>${fmtLine(b.line)}</td><td>${fmtPrice(b.price)}</td><td>${Number(b.units).toFixed(1)}u</td><td>+${Number(b.edge).toFixed(1)}</td><td>${b.betmgmVsConsensus===null||b.betmgmVsConsensus===undefined?"—":`${Number(b.betmgmVsConsensus)>=0?"+":""}${Number(b.betmgmVsConsensus).toFixed(1)}`}</td><td><button class="small-btn" onclick="removeBet(${i})">Remove</button></td>
  </tr>`).join("")}</tbody></table>`;
}
function removeBet(i){const b=getBets();b.splice(i,1);saveBets(b);} window.removeBet=removeBet;

$("betForm").addEventListener("submit",e=>{
  e.preventDefault(); if(!currentBetGame) return;
  const g=currentBetGame,bets=getBets();
  bets.unshift({createdAt:new Date().toISOString(),gameId:g.id,kickoff:g.kickoff,away:g.away,home:g.home,team:g.recommendedTeam,line:Number($("betLine").value),price:Number($("betPrice").value),units:Number($("betUnits").value),edge:Number(g.edge),edgeScore:Number(g.edgeScore),projectedLine:Number(g.projectedLine),classification:g.classification,consensusLine:g.marketConsensus?.consensusLine??null,betmgmVsConsensus:g.marketConsensus?.betmgmVsConsensus??null,matchedSystems:g.matchedSystems||[],notes:$("betNotes").value.trim()});
  saveBets(bets); $("betDialog").close();
});

function openSettings(){ $("modeSelect").value=settings.mode; $("endpointInput").value=settings.endpoint||""; $("settingsDialog").showModal(); }
$("saveSettingsBtn").addEventListener("click",async()=>{
  settings={version:SETTINGS_VERSION,mode:$("modeSelect").value,endpoint:$("endpointInput").value.trim()};
  localStorage.setItem("se-settings",JSON.stringify(settings)); $("settingsDialog").close();
  await loadGames();
  await loadPerformance();
});
$("tabs").addEventListener("click",e=>{const btn=e.target.closest(".tab");if(!btn)return;document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));btn.classList.add("active");currentFilter=btn.dataset.filter;render();});
$("sortSelect").addEventListener("change",render);
$("refreshBtn").addEventListener("click",async()=>{
  await loadGames();
  await loadPerformance();
});
$("settingsBtn").addEventListener("click",openSettings);
$("dialogClose").addEventListener("click",()=>$("gameDialog").close());
$("settingsClose").addEventListener("click",()=>$("settingsDialog").close());
$("betDialogClose").addEventListener("click",()=>$("betDialog").close());
$("clearBetsBtn").addEventListener("click",()=>{if(confirm("Clear every wager from the local bet ledger?"))saveBets([]);});

function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}

if("serviceWorker" in navigator){window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js?v=6").catch(()=>{}));}
(async()=>{
  await loadGames();
  await loadPerformance();
})();
