const LIVE_ENDPOINT = "https://ahskdtpxsjqasbpbvxja.supabase.co/functions/v1/saturday-edge-board";
const PERFORMANCE_ENDPOINT = "https://ahskdtpxsjqasbpbvxja.supabase.co/functions/v1/saturday-edge-performance";
const LIVE_EDGE_ENDPOINT = "https://ahskdtpxsjqasbpbvxja.supabase.co/functions/v1/saturday-edge-live";
const BET_CHECK_ENDPOINT = "https://ahskdtpxsjqasbpbvxja.supabase.co/functions/v1/Saturday-edge-bet-check";
const BETMGM_URL = "https://sports.betmgm.com/";
const SETTINGS_VERSION = 12;
const LIVE_AUTO_REFRESH_MS = 2 * 60 * 1000;

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

const defaultSettings = { version:SETTINGS_VERSION, mode:"live", endpoint:LIVE_ENDPOINT, liveEndpoint:LIVE_EDGE_ENDPOINT };

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
let currentTimeFilter = "ALL";
let currentShadowFilter = "ALL";
let currentBetGame = null;
let currentBetKind = "PREGAME";
let lastPayload = null;
let performance = null;
let activeView = "pregame";
let liveGames = [];
let livePayload = null;
let liveAutoTimer = null;
let pregameStatusText = "";
let liveStatusText = "Live Edge is ready.";

const $ = id => document.getElementById(id);
const fmtLine = n => n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : `${Number(n)>0?"+":""}${Number(n).toFixed(1)}`;
const fmtPrice = n => Number(n)>0 ? `+${Number(n)}` : `${Number(n)}`;
const fmtTime = iso => new Intl.DateTimeFormat("en-US",{weekday:"short",hour:"numeric",minute:"2-digit"}).format(new Date(iso));
const fmtUnits = n => n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : `${Number(n)>=0?"+":""}${Number(n).toFixed(2)}u`;
const fmtPct = n => n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : `${Number(n).toFixed(1)}%`;
const record = s => s ? `${s.wins||0}-${s.losses||0}${s.pushes ? `-${s.pushes}` : ""}` : "—";

function kickoffBucket(iso){
  const d=new Date(iso);
  if(Number.isNaN(d.getTime())) return "UNKNOWN";
  const hour=d.getHours();
  if(hour<14) return "EARLY";
  if(hour<18) return "AFTERNOON";
  return "EVENING";
}

function matchesTimeFilter(g){
  return currentTimeFilter==="ALL" || kickoffBucket(g.kickoff)===currentTimeFilter;
}

function isPregameLocked(g){
  const kickoff=new Date(g?.kickoff).getTime();
  return Number.isFinite(kickoff) && kickoff<=Date.now()+5*60*1000;
}

function formatCacheAge(ms){
  if(!Number.isFinite(ms)||ms<0) return "unknown age";
  const minutes=Math.floor(ms/60000);
  if(minutes<1) return `${Math.max(0,Math.floor(ms/1000))}s old`;
  if(minutes<60) return `${minutes}m old`;
  const hours=Math.floor(minutes/60);
  const leftover=minutes%60;
  return `${hours}h${leftover?` ${leftover}m`:""} old`;
}

function coverageReasonLabel(reason){
  return ({
    STARTED_OR_TOO_CLOSE:"Started / inside safety buffer",
    NO_BETMGM_SPREAD:"No BetMGM spread",
    MALFORMED_BETMGM_MARKET:"BetMGM market incomplete",
    TEAM_MATCH_FAILED:"Team-name match failed",
    NO_RATINGS:"No usable ratings",
    NO_CURRENT_ODDS_FEED:"Not in current odds feed",
    FILTERED:"Filtered before analysis"
  })[reason] || reason || "Coverage gap";
}

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

  const snapshots=Number(m.snapshots||0);
  const liveLine=Number(g.marketLine);
  const capturedLine=Number(m.currentLine);
  const hasLive=Number.isFinite(liveLine);
  const hasCaptured=Number.isFinite(capturedLine);
  const differs=hasLive&&hasCaptured&&Math.abs(liveLine-capturedLine)>=0.01;

  if(snapshots<=1){
    if(differs){
      return `<span class="movement-chip active">📍 Captured ${fmtLine(capturedLine)} • Live ${fmtLine(liveLine)} <small>1 snap</small></span>`;
    }
    return `<span class="movement-chip neutral">📍 First look ${fmtLine(capturedLine)} <small>1 snap</small></span>`;
  }

  const change=Number(m.lineChange||0);
  const cls=differs||Math.abs(change)>=.01?"active":"neutral";

  if(differs){
    return `<span class="movement-chip ${cls}">📈 First ${fmtLine(m.firstLine)} → Last captured ${fmtLine(capturedLine)} • Live ${fmtLine(liveLine)} <small>${snapshots} snaps</small></span>`;
  }

  return `<span class="movement-chip ${cls}">📈 First ${fmtLine(m.firstLine)} → Now ${fmtLine(capturedLine)} <small>${snapshots} snaps</small></span>`;
}

function shadowFor(g){
  const locked=performance?.shadow?.byGame?.[g?.id];
  if(locked){
    const entryLine=locked.lockedLine;
    return {
      ...(g?.shadowSelector||{}),
      version:"Saturday Edge Shadow v0.1",
      state:"LOCKED",
      selected:true,
      locked:true,
      entryLine,
      selectedAt:locked.selectedAt,
      reasons:Array.isArray(locked.reasons)&&locked.reasons.length
        ? locked.reasons
        : [`Locked prospectively at ${fmtLine(entryLine)} when the game first met every Shadow Select v0.1 rule.`]
    };
  }
  if(g?.shadowSelector?.version){
    return g.shadowSelector;
  }

  const line=Number(g?.marketLine);
  const edge=Math.abs(Number(g?.edge||0));
  const market=g?.marketConsensus;
  const vs=market?.available&&Number.isFinite(Number(market.betmgmVsConsensus))?Number(market.betmgmVsConsensus):null;
  const eligible=g?.eligibleForRecommendation===true&&Number(g?.ratingSystemCount??0)>=2;
  const reasons=[];
  let state="NEUTRAL";
  const selected=eligible&&Number.isFinite(line)&&line>0&&edge>=4.5&&edge<6&&market?.available&&vs!==null&&vs>=0;
  if(selected){
    state="SELECT";
    reasons.push("Underdog + 4.5–5.9 edge + BetMGM aligned with/better than consensus.");
  }else if((Number.isFinite(line)&&line<0)||edge>=8){
    state="CAUTION";
    if(line<0) reasons.push("Favorite profile is a locked caution.");
    if(edge>=8) reasons.push("8+ point model gaps are a locked caution.");
  }else if(eligible&&Number.isFinite(line)&&line>0&&edge>=3&&edge<6){
    state="WATCH";
    reasons.push("Underdog profile is interesting but does not meet every locked SELECT rule.");
  }
  return {version:"Saturday Edge Shadow v0.1",state,selected,reasons,reasonCodes:[],score:0};
}

function shadowChip(g){
  const d=shadowFor(g);
  const meta={
    SELECT:["🧪","SELECT","select"],
    LOCKED:["🔒","LOCKED SELECT","select"],
    WATCH:["👀","WATCH","watch"],
    CAUTION:["⛔","CAUTION","caution"],
    NEUTRAL:["•","NEUTRAL","neutral"]
  }[d.state]||["•","NEUTRAL","neutral"];
  return `<span class="shadow-chip ${meta[2]}" title="Shadow Select v0.1 is prospective research only.">${meta[0]} ${meta[1]}</span>`;
}

function matchesShadowFilter(g){
  if(currentShadowFilter==="ALL") return true;
  const state=shadowFor(g).state;
  if(currentShadowFilter==="SELECT") return state==="SELECT" || state==="LOCKED";
  return state===currentShadowFilter;
}

const LIVE_CACHE_KEY="se-live-board-cache-v066";
const LIVE_CACHE_TTL_MS=5*60*1000;

function readLiveCache(){
  try{
    const raw=localStorage.getItem(LIVE_CACHE_KEY); if(!raw) return null;
    const cached=JSON.parse(raw); if(!cached?.savedAt||!cached?.payload) return null;
    return cached;
  }catch{return null;}
}
function writeLiveCache(payload){ try{localStorage.setItem(LIVE_CACHE_KEY,JSON.stringify({savedAt:Date.now(),payload}));}catch{} }


function liveSignalMeta(signal){
  return ({
    LIVE_VALUE:["⚡ LIVE VALUE","value"],
    WATCH:["👀 WATCH","watch"],
    NO_PLAY:["🧊 NO PLAY","no-play"],
    STALE_MARKET:["⌛ STALE MARKET","stale"],
    TRACK_ONLY:["📍 TRACK ONLY","track"]
  })[signal] || ["📍 TRACK ONLY","track"];
}

function liveGameState(g){
  const p=Number(g?.period);
  const clock=g?.clock?String(g.clock):"";
  if(Number.isFinite(p)&&p>4) return `OT${p>5?` ${p-4}`:""}${clock?` • ${clock}`:""}`;
  if(Number.isFinite(p)&&p>0) return `Q${p}${clock?` • ${clock}`:""}`;
  return g?.status==="in_progress"?"LIVE":"—";
}

function lineFromHistoryForSide(row,g){
  if(!row) return null;
  if(teamNamesMatch(g?.liveModel?.recommendedTeam,g?.home)) return Number.isFinite(Number(row.betmgm_home_line))?Number(row.betmgm_home_line):null;
  if(teamNamesMatch(g?.liveModel?.recommendedTeam,g?.away)) return Number.isFinite(Number(row.betmgm_away_line))?Number(row.betmgm_away_line):null;
  return Number.isFinite(Number(row.recommended_line))?Number(row.recommended_line):null;
}

function teamNamesMatch(a,b){
  const clean=v=>String(v??"").toLowerCase().replace(/[^a-z0-9]/g,"");
  const x=clean(a),y=clean(b);
  return Boolean(x&&y&&(x===y||x.includes(y)||y.includes(x)));
}

function liveHistoryHtml(g){
  const rows=Array.isArray(g?.history)?g.history.slice(0,6).reverse():[];
  if(!rows.length) return `<span class="live-history-empty">First live snapshot</span>`;
  return rows.map(row=>{
    const line=lineFromHistoryForSide(row,g);
    const state=`${row.period?`Q${row.period} `:""}${row.clock||""}`.trim()||new Date(row.captured_at).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});
    return `<span class="live-history-point"><small>${escapeHtml(state)}</small><b>${fmtLine(line)}</b></span>`;
  }).join("");
}

async function loadLiveGames(){
  if(settings.mode!=="live"){
    liveGames=[]; livePayload=null;
    liveStatusText="Live Edge requires live data mode.";
    $("liveStatus").textContent=liveStatusText;
    renderLive();
    return;
  }
  const btn=$("liveRefreshBtn"); if(btn) btn.disabled=true;
  $("liveStatus").textContent="Loading games already in progress…";
  try{
    if(!settings.liveEndpoint) throw new Error("Add the Live Edge Function URL in Settings.");
    const r=await fetch(settings.liveEndpoint,{headers:{Accept:"application/json"},cache:"no-store"});
    const payload=await r.json().catch(()=>({}));
    if(!r.ok||payload.error) throw new Error(payload.error||`Live Edge request failed (${r.status}).`);
    livePayload=payload;
    liveGames=Array.isArray(payload.games)?payload.games:[];
    const cache=payload.cache||{};
    const cacheText=cache.cached?` • ${cache.stale?"stale fallback":"cached"} ${Number(cache.ageSeconds||0)}s`:` • fresh pull`;
    const credits=payload.oddsApiUsage?.remaining;
    const creditText=credits!==null&&credits!==undefined?` • ${credits} odds credits left`:"";
    liveStatusText=`${payload.version||"Live Edge"} • ${liveGames.length} in progress${cacheText}${creditText}`;
    if(payload.warning) liveStatusText=`⚠ ${payload.warning}`;
    $("liveStatus").textContent=liveStatusText;
    if(activeView==="live") $("statusText").textContent=liveStatusText;
  }catch(err){
    console.error(err);
    liveStatusText=`Live Edge unavailable: ${err.message}`;
    $("liveStatus").textContent=liveStatusText;
    if(activeView==="live") $("statusText").textContent=liveStatusText;
  }finally{
    if(btn) btn.disabled=false;
    renderLive();
  }
}

function renderLive(){
  const counts=livePayload?.counts||{};
  $("liveCount").textContent=Number(counts.live??liveGames.length);
  $("liveValueCount").textContent=Number(counts.liveValue??liveGames.filter(g=>g.liveModel?.signal==="LIVE_VALUE").length);
  $("liveWatchCount").textContent=Number(counts.watch??liveGames.filter(g=>g.liveModel?.signal==="WATCH").length);
  const credits=livePayload?.oddsApiUsage?.remaining;
  $("liveCredits").textContent=credits===null||credits===undefined?"—":String(credits);
  $("liveNavCount").textContent=liveGames.length;
  const board=$("liveBoard");
  if(!liveGames.length){
    board.innerHTML="";
    $("liveEmpty").classList.remove("hidden");
    renderLiveBets();
    return;
  }
  $("liveEmpty").classList.add("hidden");
  board.innerHTML=liveGames.map(g=>{
    const lm=g.liveModel||{};
    const betmgm=g.betmgm||{};
    const meta=liveSignalMeta(lm.signal);
    const score=`${g.awayScore??"—"}–${g.homeScore??"—"}`;
    const rec=lm.recommendedTeam||"Tracking only";
    const pos=g.possession?` • Poss: ${escapeHtml(g.possession)}`:"";
    const situation=g.situation?` • ${escapeHtml(g.situation)}`:"";
    const lastPlay=g.lastPlay?`<div class="live-last-play">${escapeHtml(g.lastPlay)}</div>`:"";
    const movement=lm.movementFromPregameClose;
    const movementText=movement===null||movement===undefined?"—":`${Number(movement)>=0?"+":""}${Number(movement).toFixed(1)} pts`;
    const canTrack=betmgm.available&&Number.isFinite(Number(lm.recommendedLine));
    const cautions=Array.isArray(lm.cautions)&&lm.cautions.length?`<div class="live-cautions">${lm.cautions.map(c=>`<span>⚠ ${escapeHtml(c)}</span>`).join("")}</div>`:"";
    return `<article class="live-game-card ${meta[1]}">
      <div class="live-score-row">
        <div><strong>${escapeHtml(g.away)}</strong><b>${g.awayScore??"—"}</b></div>
        <div class="live-center-state"><span class="live-dot">● LIVE</span><strong>${escapeHtml(liveGameState(g))}</strong><small>${escapeHtml(g.possession?`Possession: ${g.possession}`:g.status||"")}</small></div>
        <div><strong>${escapeHtml(g.home)}</strong><b>${g.homeScore??"—"}</b></div>
      </div>
      <div class="live-matchup-title">${escapeHtml(g.away)} @ ${escapeHtml(g.home)} <span>${score}${pos}${situation}</span></div>
      ${lastPlay}
      <div class="live-metrics">
        <div><span>Live side</span><strong>${escapeHtml(rec)}</strong></div>
        <div><span>BetMGM live</span><strong>${fmtLine(lm.recommendedLine)}</strong><small>${lm.recommendedPrice===null||lm.recommendedPrice===undefined?"":fmtPrice(lm.recommendedPrice)}</small></div>
        <div><span>Live fair line</span><strong>${fmtLine(lm.fairLineForRecommendedTeam)}</strong></div>
        <div><span>Live edge</span><strong class="${Number(lm.edge||0)>=4?"positive":""}">${lm.edge===null||lm.edge===undefined?"—":`+${Number(lm.edge).toFixed(1)}`}</strong></div>
        <div><span>Pregame close</span><strong>${fmtLine(lm.pregameCloseForRecommendedTeam)}</strong></div>
        <div><span>Move vs close</span><strong>${movementText}</strong></div>
      </div>
      <div class="live-signal-row"><span class="live-signal ${meta[1]}">${meta[0]}</span><span>Research-only v0.1 • remaining game ${(Number(lm.remainingFraction||0)*100).toFixed(0)}%</span></div>
      <div class="live-history"><label>BetMGM live-line trail</label><div>${liveHistoryHtml(g)}</div></div>
      ${cautions}
      <div class="card-actions live-card-actions"><button class="small-btn" onclick="openLiveWhy('${escapeHtml(g.gameId)}')">DETAILS</button><button class="small-btn mgm" onclick="openBetMgm()">↗ BetMGM</button>${canTrack?`<button class="small-btn bet" onclick="openLiveBet('${escapeHtml(g.gameId)}')">+ Bet Placed</button>`:`<button class="small-btn locked" disabled>Line unavailable</button>`}</div>
    </article>`;
  }).join("");
  renderLiveBets();
}

function openLiveWhy(id){
  const g=liveGames.find(x=>String(x.gameId)===String(id)); if(!g) return;
  const lm=g.liveModel||{}, b=g.betmgm||{}, p=g.pregame||{};
  $("dialogTitle").textContent=`LIVE: ${g.away} @ ${g.home}`;
  $("dialogBody").innerHTML=`<div class="why-grid">
    <div class="why-stat"><span>Score</span><strong>${g.awayScore??"—"}–${g.homeScore??"—"}</strong></div>
    <div class="why-stat"><span>Game state</span><strong>${escapeHtml(liveGameState(g))}</strong></div>
    <div class="why-stat"><span>Possession</span><strong>${escapeHtml(g.possession||"—")}</strong></div>
    <div class="why-stat"><span>Live side</span><strong>${escapeHtml(lm.recommendedTeam||"Tracking only")}</strong></div>
    <div class="why-stat"><span>BetMGM live line</span><strong>${fmtLine(lm.recommendedLine)}</strong></div>
    <div class="why-stat"><span>Live fair line</span><strong>${fmtLine(lm.fairLineForRecommendedTeam)}</strong></div>
    <div class="why-stat"><span>Live edge</span><strong>${lm.edge===null||lm.edge===undefined?"—":`+${Number(lm.edge).toFixed(1)}`}</strong></div>
    <div class="why-stat"><span>Pregame close</span><strong>${fmtLine(lm.pregameCloseForRecommendedTeam)}</strong></div>
    <div class="why-stat"><span>Pregame model</span><strong>${fmtLine(lm.pregameModelForRecommendedTeam)}</strong></div>
  </div>
  <div class="diagnostic-explain"><strong>⚡ Live Edge v0.1</strong><span>${escapeHtml(lm.methodology||"Current score plus remaining share of the pregame model margin.")}</span><span class="diag-caution">Possession is context only in v0.1. This live signal is research-only and does not alter MODEL v0.5 or Shadow Select.</span></div>
  ${g.lastPlay?`<div class="reason info"><strong>Last play:</strong> ${escapeHtml(g.lastPlay)}</div>`:""}
  ${(lm.cautions||[]).map(c=>`<div class="reason caution">${escapeHtml(c)}</div>`).join("")}`;
  $("gameDialog").showModal();
}
window.openLiveWhy=openLiveWhy;

function populateBetTeamOptions(options,preferred){
  const select=$("betTeam");
  select.innerHTML=options.map(o=>`<option value="${escapeHtml(o.team)}" data-line="${o.line}" data-price="${o.price??-110}">${escapeHtml(o.team)}</option>`).join("");
  if(preferred&&options.some(o=>o.team===preferred)) select.value=preferred;
  const sync=()=>{
    const opt=select.selectedOptions[0]; if(!opt) return;
    $("betLine").value=Number(opt.dataset.line).toFixed(1);
    $("betPrice").value=Number(opt.dataset.price||-110);
  };
  select.onchange=sync; sync();
}

function openLiveBet(id){
  const g=liveGames.find(x=>String(x.gameId)===String(id)); if(!g||!g.betmgm?.available) return;
  currentBetGame=g; currentBetKind="LIVE"; $("betGameId").value=g.gameId;
  const options=[
    {team:g.home,line:Number(g.betmgm.homeLine),price:g.betmgm.homePrice??-110},
    {team:g.away,line:Number(g.betmgm.awayLine),price:g.betmgm.awayPrice??-110}
  ].filter(o=>Number.isFinite(o.line));
  populateBetTeamOptions(options,g.liveModel?.recommendedTeam);
  $("betDialogTitle").textContent=`Live bet • ${g.away} @ ${g.home}`;
  $("betContext").classList.remove("hidden");
  $("betContext").innerHTML=`<strong>${escapeHtml(liveGameState(g))}</strong> • Score ${g.awayScore??"—"}–${g.homeScore??"—"} • Live Edge signal ${escapeHtml(g.liveModel?.signalLabel||g.liveModel?.signal||"TRACK ONLY")}`;
  $("betUnits").value="1"; $("betStake").value=""; $("betNotes").value=""; $("betDialog").showModal();
}
window.openLiveBet=openLiveBet;

function renderLiveBets(){
  const all=getBets().map((b,i)=>({b,i}));
  const rows=all.filter(x=>x.b.kind==="LIVE");
  $("liveBetCount").textContent=rows.length;
  $("liveUnitsRisked").textContent=`${rows.reduce((s,x)=>s+Number(x.b.units||0),0).toFixed(1)}u`;
  if(!rows.length){$("liveBetsTableWrap").innerHTML=`<div class="empty">No in-game BetMGM wagers tracked yet. Use “+ Bet Placed” on a live card.</div>`;return;}
  $("liveBetsTableWrap").innerHTML=`<table class="bets-table"><thead><tr><th>Time</th><th>Game</th><th>State</th><th>Side</th><th>Line</th><th>Stake</th><th>Result</th><th>Net</th><th>Live edge</th><th></th></tr></thead><tbody>${rows.map(({b,i})=>`<tr>
    <td>${new Date(b.createdAt).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</td><td>${escapeHtml(b.away)} @ ${escapeHtml(b.home)}</td><td>${escapeHtml(b.gameState||"LIVE")}<br><small>${escapeHtml(b.scoreAtBet||"")}</small></td><td>${escapeHtml(b.team)} ${fmtLine(b.line)}<br><small>${fmtPrice(b.price)}</small></td><td>${fmtLine(b.line)}</td><td>${Number(b.stake)>0?`$${Number(b.stake).toFixed(2)}`:`${Number(b.units).toFixed(1)}u`}</td><td>${resultPill(b)}</td><td>${["WIN","LOSS","PUSH"].includes(b.result)?fmtUnits(b.unitsProfit):"—"}</td><td>${b.edge===null||b.edge===undefined?"—":`${Number(b.edge)>=0?"+":""}${Number(b.edge).toFixed(1)}`}</td><td><button class="small-btn" onclick="removeBet(${i})">Remove</button></td>
  </tr>`).join("")}</tbody></table>`;
}

function stopLiveAutoRefresh(){ if(liveAutoTimer){clearInterval(liveAutoTimer);liveAutoTimer=null;} }
function startLiveAutoRefresh(){
  stopLiveAutoRefresh();
  liveAutoTimer=setInterval(()=>{ if(activeView==="live") loadLiveGames(); },LIVE_AUTO_REFRESH_MS);
}

async function switchView(view){
  if(view===activeView) return;
  if(activeView==="pregame") pregameStatusText=$("statusText").textContent;
  activeView=view;
  $("pregamePane").classList.toggle("hidden",view!=="pregame");
  $("livePane").classList.toggle("hidden",view!=="live");
  $("pregameViewBtn").classList.toggle("active",view==="pregame");
  $("liveViewBtn").classList.toggle("active",view==="live");
  if(view==="live"){
    $("refreshBtn").textContent="↻ Refresh Live";
    $("statusText").textContent=liveStatusText;
    if(!livePayload) await loadLiveGames();
    startLiveAutoRefresh();
  }else{
    stopLiveAutoRefresh();
    $("refreshBtn").textContent="↻ Refresh";
    $("statusText").textContent=pregameStatusText||`Pregame board • ${games.length} games`;
  }
}

async function loadGames(){
  $("refreshBtn").disabled=true;
  $("statusText").textContent=settings.mode==="live"?"Loading BetMGM spread board…":"Demo mode is active.";

  const cached=settings.mode==="live"?readLiveCache():null;
  const cacheAge=cached?Date.now()-cached.savedAt:Infinity;

  try{
    if(settings.mode==="live"){
      if(!settings.endpoint) throw new Error("Add the Supabase Edge Function URL in Settings.");

      let payload=null, source="live";

      // Normal quota protection: fresh browser cache wins for 5 minutes.
      if(cached&&cacheAge<LIVE_CACHE_TTL_MS){
        payload=cached.payload;
        source="cache";
      }else{
        try{
          const r=await fetch(settings.endpoint,{headers:{Accept:"application/json"},cache:"no-store"});
          payload=await r.json().catch(()=>({}));
          if(!r.ok) throw new Error(payload.error||`Live data request failed (${r.status}).`);
          if(payload.error) throw new Error(payload.error);
          writeLiveCache(payload);
        }catch(fetchError){
          // Hardening v0.6.3: never replace a previously good board with demo
          // data just because the live provider has a temporary outage.
          if(cached?.payload&&Array.isArray(cached.payload.games)){
            payload=cached.payload;
            source="stale";
            console.warn("Live board unavailable, using last successful browser cache.",fetchError);
          }else{
            throw fetchError;
          }
        }
      }

      lastPayload=payload;
      games=Array.isArray(payload.games)?payload.games:[];

      const credits=payload.oddsApiUsage?.remaining;
      const creditText=credits!==null&&credits!==undefined?` • ${credits} odds credits left`:"";

      if(source==="stale"){
        $("statusText").textContent=`⚠ Live odds temporarily unavailable • showing last successful board (${formatCacheAge(cacheAge)}) • ${games.length} games${creditText}`;
      }else{
        const ageText=source==="cache"?` • cached ${Math.max(0,Math.floor(cacheAge/1000))}s ago`:" • fresh pull";
        $("statusText").textContent=`Live board • ${payload.modelVersion||"model"} • ${games.length} games${ageText}${creditText}`;
      }
    }else{
      lastPayload=null;
      games=DEMO_GAMES;
      $("statusText").textContent="Demo mode • no live API usage";
    }
  }catch(err){
    console.error(err);
    games=DEMO_GAMES;
    lastPayload=null;
    $("statusText").textContent=`${err.message} No prior live board was available, so demo data is shown.`;
  }finally{
    if(activeView==="pregame") pregameStatusText=$("statusText").textContent;
    $("refreshBtn").disabled=false;
    renderCoverage();
    renderShadowPerformance();
    render();
  }
}

async function loadPerformance(){
  if(settings.mode!=="live"){
    performance=null;
    $("performanceStatus").textContent="Performance receipts are available in live mode.";
    renderPerformance(); renderShadowPerformance();
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
  renderPerformance(); renderShadowPerformance(); render();
}

function renderCoverage(){
  const c=lastPayload?.coverageAudit;

  if(!c){
    $("pipelineBadge").textContent="🛡 Pipeline check";
    $("coverageStatus").textContent=settings.mode==="live"
      ?"Coverage details will appear after the hardened board function is deployed."
      :"Coverage audit is available in live mode.";
    $("coverageGrid").innerHTML=`
      <article class="coverage-card"><span>Odds feed</span><strong>—</strong><small>events returned</small></article>
      <article class="coverage-card"><span>Today's schedule</span><strong>—</strong><small>CFBD games, Eastern date</small></article>
      <article class="coverage-card good"><span>Analyzed today</span><strong>—</strong><small>made the model board</small></article>
      <article class="coverage-card warn"><span>Coverage gaps</span><strong>—</strong><small>visible reasons, no silent drops</small></article>`;
    $("coverageDetails").innerHTML="";
    return;
  }

  const attempts=Number(c.oddsFetch?.attempts||1);
  const recovered=Boolean(c.oddsFetch?.recoveredAfterRetry);
  $("pipelineBadge").textContent=recovered?`🛡 Recovered in ${attempts} tries`:"🛡 Feed healthy";
  $("coverageStatus").textContent=`${c.pipelineVersion||"Hardened board"} • ${c.date||"today"} ET • Odds request ${recovered?`recovered after ${attempts} attempts`:`succeeded on attempt ${attempts}`}.`;

  $("coverageGrid").innerHTML=`
    <article class="coverage-card"><span>Odds feed</span><strong>${Number(c.oddsFeedEvents||0)}</strong><small>events returned now</small></article>
    <article class="coverage-card"><span>Today's schedule</span><strong>${Number(c.scheduleGamesToday||0)}</strong><small>CFBD games on ${escapeHtml(c.date||"today")} ET</small></article>
    <article class="coverage-card good"><span>Analyzed today</span><strong>${Number(c.analyzedToday||0)}</strong><small>made the model board</small></article>
    <article class="coverage-card ${Number(c.gapsToday||0)>0?"warn":"good"}"><span>Coverage gaps</span><strong>${Number(c.gapsToday||0)}</strong><small>${Number(c.gapsToday||0)>0?"tap below to see why":"no silent drops detected"}</small></article>`;

  const gaps=Array.isArray(c.gaps)?c.gaps:[];
  const excluded=c.excludedCounts||{};
  const limited=c.limitedButIncluded||{};

  // v0.6.4 separates TODAY'S gaps from diagnostics across the entire upcoming odds feed.
  const todayCounts={};
  gaps.forEach(g=>{
    const key=g.reason||g.status||"UNKNOWN";
    todayCounts[key]=(todayCounts[key]||0)+1;
  });

  const todaySummary=`
    <div class="coverage-label">Today's slate</div>
    <div class="coverage-reasons today-reasons">
      <span>Started/too close <strong>${Number(todayCounts.STARTED_OR_TOO_CLOSE||0)}</strong></span>
      <span>Not in odds feed <strong>${Number(todayCounts.NO_CURRENT_ODDS_FEED||0)}</strong></span>
      <span>No BetMGM <strong>${Number(todayCounts.NO_BETMGM_SPREAD||0)}</strong></span>
      <span>Team match <strong>${Number(todayCounts.TEAM_MATCH_FAILED||0)}</strong></span>
      <span>No ratings <strong>${Number(todayCounts.NO_RATINGS||0)}</strong></span>
      <span>Bad market <strong>${Number(todayCounts.MALFORMED_BETMGM_MARKET||0)}</strong></span>
    </div>`;

  const feedSummary=`
    <details class="feed-diagnostics">
      <summary>Entire upcoming feed diagnostics</summary>
      <div class="coverage-reasons">
        <span>Started/too close <strong>${Number(excluded.startedOrTooClose||0)}</strong></span>
        <span>No BetMGM <strong>${Number(excluded.noBetmgmSpread||0)}</strong></span>
        <span>Bad market <strong>${Number(excluded.malformedBetmgmMarket||0)}</strong></span>
        <span>Team match <strong>${Number(excluded.unmatchedTeams||0)}</strong></span>
        <span>No ratings <strong>${Number(excluded.noRatings||0)}</strong></span>
        <span>Limited ratings, still shown <strong>${Number(limited.insufficientRatings||0)}</strong></span>
        <span>No consensus, still shown <strong>${Number(limited.noConsensus||0)}</strong></span>
      </div>
    </details>`;

  if(!gaps.length){
    $("coverageDetails").innerHTML=`${todaySummary}${feedSummary}<div class="coverage-clear">✓ Every CFBD game on today's Eastern calendar that can be matched to the current feed is accounted for.</div>`;
    return;
  }

  $("coverageDetails").innerHTML=`
    ${todaySummary}
    <details class="coverage-gap-box" open>
      <summary>⚠ Show ${gaps.length} game${gaps.length===1?"":"s"} not on the analyzed board</summary>
      <div class="coverage-gap-list">
        ${gaps.map(g=>`
          <div class="coverage-gap-row">
            <div>
              <strong>${escapeHtml(g.away||"Unknown")} @ ${escapeHtml(g.home||"Unknown")}</strong>
              <span>${g.kickoff?fmtTime(g.kickoff):"Kickoff TBD"}</span>
            </div>
            <div class="coverage-gap-reason">
              <b>${escapeHtml(coverageReasonLabel(g.reason||g.status))}</b>
              <small>${escapeHtml(g.detail||g.reason||"Not analyzed")}</small>
            </div>
          </div>`).join("")}
      </div>
    </details>
    ${feedSummary}`;
}

function renderShadowPerformance(){
  const el=$("shadowGrid");
  if(!el) return;

  const liveSelects=games.filter(g=>["SELECT","LOCKED"].includes(shadowFor(g).state)).length;
  const currentCount=$("shadowCurrentCount");
  if(currentCount) currentCount.textContent=String(liveSelects);

  const shadow=performance?.shadow;
  const fmtClv=value=>value===null||value===undefined||!Number.isFinite(Number(value))
    ?"—"
    :`${Number(value)>=0?"+":""}${Number(value).toFixed(2)}`;

  if(!shadow || shadow.enabled===false){
    const detail=shadow?.readError?` ${shadow.readError}`:"";
    $("shadowStatus").textContent=`Shadow receipts are unavailable.${detail}`;
    el.innerHTML=`
      <article class="performance-card hero-metric"><span>Shadow ATS</span><strong>0-0</strong><small>Week 8 forward only</small></article>
      <article class="performance-card"><span>Units</span><strong>+0.00u</strong><small>1u risk per selection</small></article>
      <article class="performance-card"><span>Avg CLV</span><strong>—</strong><small>Entry vs observed close</small></article>
      <article class="performance-card"><span>Current selects</span><strong>${liveSelects}</strong><small>live board candidates</small></article>`;
    $("shadowWeeks").innerHTML=`<div class="empty compact">No Shadow Select v0.1 graded games yet.</div>`;
    $("shadowRecent").innerHTML="";
    return;
  }

  const p=shadow.overall||{};
  $("shadowStatus").textContent=`Prospective only • ${p.selectedGames||0} locked selection${Number(p.selectedGames||0)===1?"":"s"} • ${p.pendingGames||0} pending`;
  el.innerHTML=`
    <article class="performance-card hero-metric"><span>Shadow ATS</span><strong>${record(p)}</strong><small>${fmtPct(p.atsWinRate)} • ${p.gradedGames||0} graded</small></article>
    <article class="performance-card"><span>Units</span><strong class="${Number(p.unitsProfit||0)>=0?"positive":"negative"}">${fmtUnits(p.unitsProfit??0)}</strong><small>1u risk per selection</small></article>
    <article class="performance-card"><span>Avg CLV</span><strong>${fmtClv(p.avgClv)}</strong><small>Entry vs observed close</small></article>
    <article class="performance-card"><span>Current selects</span><strong>${liveSelects}</strong><small>live board candidates</small></article>`;

  const weeks=Array.isArray(shadow.byWeek)?shadow.byWeek:[];
  $("shadowWeeks").innerHTML=weeks.length?weeks.map(w=>`<article class="week-card shadow-week-card">
    <div class="week-card-head"><div><span>Season ${escapeHtml(String(w.season||"—"))}</span><strong>Week ${escapeHtml(String(w.week||"—"))}</strong></div><small>${w.selectedGames||0} selected • ${w.gradedGames||0} graded</small></div>
    <div class="week-record">${record(w)} <span>${fmtPct(w.atsWinRate)}</span></div>
    <div class="week-metrics"><span>Units <b class="${Number(w.unitsProfit||0)>=0?"positive":"negative"}">${fmtUnits(w.unitsProfit)}</b></span><span>ROI <b>${fmtPct(w.roi)}</b></span><span>CLV <b>${fmtClv(w.avgClv)}</b></span></div>
  </article>`).join(""):`<div class="empty compact">Week 8 is the first prospective Shadow Select week. No graded receipts yet.</div>`;

  const recent=Array.isArray(shadow.recent)?shadow.recent:[];
  $("shadowRecent").innerHTML=recent.length?`<div class="recent-heading"><strong>Latest shadow selections</strong><span>Frozen at first qualifying pregame state.</span></div>
    <div class="table-wrap"><table class="bets-table performance-table"><thead><tr><th>Week</th><th>Game</th><th>Side</th><th>Entry</th><th>ATS</th><th>Margin</th><th>Units</th><th>CLV</th></tr></thead><tbody>${recent.map(r=>`<tr>
      <td>W${escapeHtml(String(r.week??"—"))}</td><td>${escapeHtml(r.away)} @ ${escapeHtml(r.home)}</td><td>${escapeHtml(r.recommendedTeam)}</td><td>${fmtLine(r.lockedLine)}</td><td><span class="result-pill ${(r.atsResult||r.status||"").toLowerCase()}">${escapeHtml(r.atsResult||r.status||"—")}</span></td><td>${r.atsMargin===null?"—":`${Number(r.atsMargin)>=0?"+":""}${Number(r.atsMargin).toFixed(1)}`}</td><td>${fmtUnits(r.unitsProfit)}</td><td>${r.closingLineValue===null?"—":`${Number(r.closingLineValue)>=0?"+":""}${Number(r.closingLineValue).toFixed(1)}`}</td>
    </tr>`).join("")}</tbody></table></div>`:"";
}

function renderPerformance(){
  const a=performance?.actionable;
  const weeklyEl=$("weeklyPerformance");
  const diagEl=$("diagnosticBreakdown");

  const fmtClv=value=>value===null||value===undefined||!Number.isFinite(Number(value))
    ?"—"
    :`${Number(value)>=0?"+":""}${Number(value).toFixed(2)}`;

  const metricRow=item=>`<tr>
    <td><strong>${escapeHtml(item.label||item.key||"Unknown")}</strong></td>
    <td>${record(item)}</td>
    <td>${fmtPct(item.atsWinRate)}</td>
    <td class="${Number(item.unitsProfit||0)>=0?"positive":"negative"}">${fmtUnits(item.unitsProfit)}</td>
    <td>${fmtClv(item.avgClv)}</td>
    <td>${Number(item.gradedGames||0)}</td>
  </tr>`;

  if(!a){
    $("performanceGrid").innerHTML=`
      <article class="performance-card hero-metric"><span>Actionable ATS</span><strong>—</strong><small>PLAYABLE + STRONG</small></article>
      <article class="performance-card"><span>Units</span><strong>—</strong><small>No research units counted</small></article>
      <article class="performance-card"><span>Avg CLV</span><strong>—</strong><small>First actionable vs close</small></article>
      <article class="performance-card"><span>ROI</span><strong>—</strong><small>Prospective sample</small></article>`;
    $("performanceBreakdown").innerHTML="";
    if(weeklyEl) weeklyEl.innerHTML=`<div class="empty compact">Week-by-week receipts require Performance v0.2.</div>`;
    if(diagEl) diagEl.innerHTML=`<div class="empty compact">Diagnostic splits require Performance v0.2.</div>`;
    $("recentResults").innerHTML="";
    return;
  }

  $("performanceGrid").innerHTML=`
    <article class="performance-card hero-metric"><span>Actionable ATS</span><strong>${record(a)}</strong><small>${fmtPct(a.atsWinRate)} • ${a.gradedGames||0} graded</small></article>
    <article class="performance-card"><span>Units</span><strong class="${Number(a.unitsProfit||0)>=0?"positive":"negative"}">${fmtUnits(a.unitsProfit)}</strong><small>1u risk per graded play</small></article>
    <article class="performance-card"><span>Avg CLV</span><strong>${fmtClv(a.avgClv)}</strong><small>points vs observed close</small></article>
    <article class="performance-card"><span>ROI</span><strong>${fmtPct(a.roi)}</strong><small>Prospective actionable sample</small></article>`;

  const b=performance.byClassification||{};
  $("performanceBreakdown").innerHTML=["STRONG","PLAYABLE","LEAN","PASS"].map(c=>{
    const s=b[c]||{};
    const actionable=s.accounting==="ACTIONABLE";
    return `<article class="split-card ${actionable?"actionable":"research"}">
      <div><span class="badge ${c}">${badgeText(c)}</span><small>${actionable?"BANKROLL":"RESEARCH ONLY"}</small></div>
      <strong>${record(s)}</strong>
      <span>${fmtPct(s.atsWinRate)} ATS • ${s.gradedGames||0} graded</span>
      <span>${actionable?`${fmtUnits(s.unitsProfit)} • CLV ${fmtClv(s.avgClv)}`:"No units counted"}</span>
    </article>`;
  }).join("");

  const weeks=Array.isArray(performance.byWeek)?performance.byWeek:[];
  if(weeklyEl){
    if(!weeks.length){
      weeklyEl.innerHTML=`<div class="empty compact">Week-by-week results will appear after Performance v0.2 is deployed.</div>`;
    }else{
      weeklyEl.innerHTML=weeks.map(w=>{
        const wa=w.actionable||{};
        const wc=w.byClassification||{};
        return `<article class="week-card">
          <div class="week-card-head"><div><span>Season ${escapeHtml(String(w.season||"—"))}</span><strong>Week ${escapeHtml(String(w.week||"—"))}</strong></div><small>${wa.gradedGames||0} actionable</small></div>
          <div class="week-record">${record(wa)} <span>${fmtPct(wa.atsWinRate)}</span></div>
          <div class="week-metrics">
            <span>Units <b class="${Number(wa.unitsProfit||0)>=0?"positive":"negative"}">${fmtUnits(wa.unitsProfit)}</b></span>
            <span>ROI <b>${fmtPct(wa.roi)}</b></span>
            <span>CLV <b>${fmtClv(wa.avgClv)}</b></span>
          </div>
          <div class="week-splits">
            <span>🔥 Strong <b>${record(wc.STRONG||{})}</b></span>
            <span>🟢 Playable <b>${record(wc.PLAYABLE||{})}</b></span>
            <span>🟡 Lean <b>${record(wc.LEAN||{})}</b> <em>research</em></span>
          </div>
        </article>`;
      }).join("");
    }
  }

  const d=performance.diagnostics;
  if(diagEl){
    if(!d){
      diagEl.innerHTML=`<div class="empty compact">Diagnostic splits will appear after Performance v0.2 is deployed.</div>`;
    }else{
      const sections=[
        ["Model edge",d.edgeBuckets||[]],
        ["Favorite / underdog",d.sideType||[]],
        ["Home / away side",d.venueSide||[]],
        ["Matchup level",d.matchupType||[]],
        ["Closing-line value",d.clvDirection||[]]
      ];
      diagEl.innerHTML=sections.map(([title,rows])=>`
        <section class="diagnostic-group">
          <h4>${escapeHtml(title)}</h4>
          ${rows.length?`<div class="table-wrap diagnostic-table-wrap"><table class="diagnostic-table">
            <thead><tr><th>Bucket</th><th>ATS</th><th>Win%</th><th>Units</th><th>CLV</th><th>N</th></tr></thead>
            <tbody>${rows.map(metricRow).join("")}</tbody>
          </table></div>`:`<div class="empty compact">No graded actionable plays in this split.</div>`}
        </section>`).join("");
      if(Array.isArray(d.warnings)&&d.warnings.length){
        diagEl.innerHTML+=`<div class="diagnostic-warning">⚠ ${d.warnings.map(escapeHtml).join(" • ")}</div>`;
      }
    }
  }

  const recent=performance.recent||[];
  if(!recent.length){
    $("recentResults").innerHTML=`<div class="empty compact">No completed prospective games graded yet.</div>`;
    return;
  }
  $("recentResults").innerHTML=`<div class="recent-heading"><strong>Latest graded games</strong><span>Research rows are intentionally excluded from bankroll units.</span></div>
    <div class="table-wrap"><table class="bets-table performance-table">
      <thead><tr><th>Week</th><th>Game</th><th>Side</th><th>Class</th><th>Final</th><th>ATS</th><th>Margin</th><th>Units</th><th>CLV</th></tr></thead>
      <tbody>${recent.map(r=>`<tr>
        <td>W${escapeHtml(String(r.week??"—"))}</td>
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
  let shown=games.filter(g=>
    (currentFilter==="ALL"||g.classification===currentFilter) &&
    matchesTimeFilter(g) &&
    matchesShadowFilter(g)
  );
  shown.sort((a,b)=>{
    if(sort==="time") return new Date(a.kickoff)-new Date(b.kickoff);
    if(sort==="score") return Number(b.edgeScore||0)-Number(a.edgeScore||0);
    return Math.abs(Number(b.edge||0))-Math.abs(Number(a.edge||0));
  });

  $("board").innerHTML=shown.map(g=>{
    const consensus=g.marketConsensus?.available?fmtLine(g.marketConsensus.consensusLine):"—";
    const systems=Array.isArray(g.matchedSystems)?g.matchedSystems.join(" + "):"—";
    const locked=isPregameLocked(g);
    return `<article class="game-card ${locked?"locked-game":""}">
      <div class="matchup">
        <strong>${escapeHtml(g.away)} @ ${escapeHtml(g.home)}</strong>
        <span>${fmtTime(g.kickoff)} • BetMGM ${fmtPrice(g.marketPrice??-110)} • Models: ${escapeHtml(systems)}</span>
        <div class="market-row">${locked?`<span class="market-chip caution">🔒 PREGAME CARD LOCKED</span>`:""} ${shadowChip(g)} ${marketChip(g)} <span class="consensus-text">Consensus ${consensus}${g.marketConsensus?.bookCount?` (${g.marketConsensus.bookCount} books)`:""}</span>${movementChip(g)}</div>
      </div>
      <div class="metric"><label>Best side</label><strong>${escapeHtml(g.recommendedTeam)}</strong></div>
      <div class="metric"><label>BetMGM</label><strong>${fmtLine(g.marketLine)}</strong></div>
      <div class="metric"><label>Our line</label><strong>${fmtLine(g.projectedLine)}</strong></div>
      <div class="metric"><label>Edge</label><strong class="edge-positive">+${Math.abs(Number(g.edge||0)).toFixed(1)}</strong></div>
      <div class="rating"><span class="badge ${escapeHtml(g.classification)}">${badgeText(g.classification)} ${Math.round(Number(g.edgeScore||0))}</span></div>
      <div class="card-actions"><button class="small-btn" onclick="openWhy('${g.id}')">WHY?</button><button class="small-btn mgm" onclick="openBetMgm()">↗ BetMGM</button>${locked?`<button class="small-btn locked" disabled>🔒 Locked</button>`:`<button class="small-btn bet" onclick="openBet('${g.id}')">+ Bet Placed</button>`}</div>
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
  const shadow=shadowFor(g);
  const systems=Array.isArray(g.matchedSystems)&&g.matchedSystems.length?g.matchedSystems.join(", "):"None";
  const capturedDiffers=move&&Number.isFinite(Number(g.marketLine))&&Number.isFinite(Number(move.currentLine))
    ? Math.abs(Number(g.marketLine)-Number(move.currentLine))>=0.01
    : false;
  const movementStats=move?`
    <div class="why-stat"><span>First recorded line</span><strong>${fmtLine(move.firstLine)}</strong></div>
    <div class="why-stat"><span>Latest captured line</span><strong>${fmtLine(move.currentLine)}</strong></div>
    ${capturedDiffers?`<div class="why-stat"><span>Live BetMGM line</span><strong>${fmtLine(g.marketLine)}</strong></div>`:""}
    <div class="why-stat"><span>Evidence snapshots</span><strong>${move.snapshots}</strong></div>`:"";
  $("dialogTitle").textContent=`${g.away} @ ${g.home}`;
  $("dialogBody").innerHTML=`<div class="why-grid">
    <div class="why-stat"><span>Recommended side</span><strong>${escapeHtml(g.recommendedTeam)} ${fmtLine(g.marketLine)}</strong></div>
    <div class="why-stat"><span>Our projected line</span><strong>${fmtLine(g.projectedLine)}</strong></div>
    <div class="why-stat"><span>Model edge</span><strong class="edge-positive">+${Math.abs(Number(g.edge||0)).toFixed(1)} pts</strong></div>
    <div class="why-stat"><span>Market consensus</span><strong>${m.available?fmtLine(m.consensusLine):"Unavailable"}</strong></div>
    <div class="why-stat"><span>BetMGM vs market</span><strong>${m.available?`${Number(m.betmgmVsConsensus||0)>=0?"+":""}${Number(m.betmgmVsConsensus||0).toFixed(1)} pts`:"—"}</strong></div>
    <div class="why-stat"><span>Rating systems</span><strong>${escapeHtml(systems)}</strong></div>
    <div class="why-stat"><span>Shadow Select</span><strong>${shadow.state}</strong></div>${movementStats}
  </div>
  <div class="diagnostic-explain">
    <strong>🧪 Shadow Select v0.1</strong>
    <span>${escapeHtml((shadow.reasons||[]).join(" ")||"This game does not currently trigger a locked shadow rule.")}</span>
    <span class="diag-caution">Prospective only. MODEL v0.5 classification is unchanged.</span>
  </div>
  <div class="reason-list">${(g.factors||[]).map(f=>`<div class="reason ${f.type||"info"}">${escapeHtml(f.text)}</div>`).join("")}</div>`;
  $("gameDialog").showModal();
}
window.openWhy=openWhy;

function openBet(id){
  const g=games.find(x=>x.id===id); if(!g) return;
  if(isPregameLocked(g)){
    alert("This game has started or is inside the 5-minute pregame safety buffer. Use the LIVE EDGE tab for in-game tracking.");
    return;
  }
  currentBetGame=g; currentBetKind="PREGAME"; $("betGameId").value=g.id;
  populateBetTeamOptions([{team:g.recommendedTeam,line:Number(g.marketLine),price:g.marketPrice??-110}],g.recommendedTeam);
  $("betDialogTitle").textContent=`${g.recommendedTeam} ${fmtLine(g.marketLine)}`;
  $("betContext").classList.add("hidden"); $("betContext").innerHTML="";
  $("betUnits").value="1"; $("betStake").value=""; $("betNotes").value=""; $("betDialog").showModal();
}
window.openBet=openBet;

function makeBetId(){
  if(globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `bet-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
}
function getBets(){
  try{
    const rows=JSON.parse(localStorage.getItem("se-bets")||"[]");
    if(!Array.isArray(rows)) return [];
    let changed=false;
    rows.forEach(b=>{if(!b.id){b.id=makeBetId();changed=true;} if(!b.kind)b.kind="PREGAME"; if(!b.result)b.result="PENDING";});
    if(changed)localStorage.setItem("se-bets",JSON.stringify(rows));
    return rows;
  }catch{return [];}
}
function saveBets(bets){
  localStorage.setItem("se-bets",JSON.stringify(bets));
  renderBets(); renderLiveBets(); renderBetMgmPerformance();
}
function betSummary(rows){
  const graded=rows.filter(b=>["WIN","LOSS","PUSH"].includes(String(b.result||"").toUpperCase()));
  const wins=graded.filter(b=>b.result==="WIN").length, losses=graded.filter(b=>b.result==="LOSS").length, pushes=graded.filter(b=>b.result==="PUSH").length;
  const unitsProfit=graded.reduce((s,b)=>s+Number(b.unitsProfit||0),0);
  const unitsRisked=graded.reduce((s,b)=>s+Number(b.units||0),0);
  const cashRows=graded.filter(b=>Number.isFinite(Number(b.stake))&&Number(b.stake)>0&&Number.isFinite(Number(b.dollarsProfit)));
  const dollarsProfit=cashRows.reduce((s,b)=>s+Number(b.dollarsProfit||0),0);
  const dollarsRisked=cashRows.reduce((s,b)=>s+Number(b.stake||0),0);
  const clvs=graded.map(b=>Number(b.clv)).filter(Number.isFinite);
  return {graded:graded.length,wins,losses,pushes,pending:rows.length-graded.length,unitsProfit,unitsRisked,roi:unitsRisked?unitsProfit/unitsRisked*100:null,dollarsProfit,dollarsRisked,cashCount:cashRows.length,avgClv:clvs.length?clvs.reduce((a,b)=>a+b,0)/clvs.length:null};
}
function splitCard(label,s){
  return `<article class="split-card actionable"><div><strong>${escapeHtml(label)}</strong><small>${s.graded} GRADED</small></div><strong>${s.wins}-${s.losses}${s.pushes?`-${s.pushes}`:""}</strong><span>${fmtUnits(s.unitsProfit)} • ROI ${fmtPct(s.roi)}${s.avgClv===null?"":` • CLV ${s.avgClv>=0?"+":""}${s.avgClv.toFixed(2)}`}</span></article>`;
}
function renderBetMgmPerformance(){
  const bets=getBets(), all=betSummary(bets), pre=betSummary(bets.filter(b=>b.kind!=="LIVE")), live=betSummary(bets.filter(b=>b.kind==="LIVE"));
  $("personalRecord").textContent=`${all.wins}-${all.losses}${all.pushes?`-${all.pushes}`:""}`;
  $("personalRecordSub").textContent=`${all.graded} graded • ${all.pending} pending`;
  $("personalUnits").textContent=fmtUnits(all.unitsProfit);
  $("personalUnits").className=all.unitsProfit>0?"positive":all.unitsProfit<0?"negative":"";
  $("personalUnitsSub").textContent=`${all.unitsRisked.toFixed(1)}u graded risk`;
  $("personalRoi").textContent=fmtPct(all.roi);
  $("personalRoi").className=all.roi>0?"positive":all.roi<0?"negative":"";
  $("personalDollars").textContent=`${all.dollarsProfit<0?"-":""}$${Math.abs(all.dollarsProfit).toFixed(2)}`;
  $("personalDollars").className=all.dollarsProfit>0?"positive":all.dollarsProfit<0?"negative":"";
  $("personalDollarsSub").textContent=all.cashCount?`$${all.dollarsRisked.toFixed(2)} graded cash risk`:`Add stake $ to track cash P/L`;
  $("personalSplits").innerHTML=splitCard("🏟️ Pregame",pre)+splitCard("⚡ Live Edge",live);
  $("pendingBetCount").textContent=all.pending;
}
function resultPill(b){
  const r=String(b.result||"PENDING").toUpperCase();
  if(r==="WIN")return `<span class="result-pill win">WIN</span>`;
  if(r==="LOSS")return `<span class="result-pill loss">LOSS</span>`;
  if(r==="PUSH")return `<span class="result-pill push">PUSH</span>`;
  return `<span class="result-pill pending">PENDING</span>`;
}
function renderBets(){
  const bets=getBets(); $("betCount").textContent=bets.length;
  $("unitsRisked").textContent=`${bets.reduce((s,b)=>s+Number(b.units||0),0).toFixed(1)}u`;
  if(!bets.length){$("betsTableWrap").innerHTML=`<div class="empty">No BetMGM wagers tracked yet. Use “+ Bet Placed” on a Pregame or Live Edge card.</div>`;return;}
  $("betsTableWrap").innerHTML=`<table class="bets-table personal-bets-table"><thead><tr><th>Date</th><th>Type</th><th>Game</th><th>Side</th><th>Line</th><th>Odds</th><th>Stake</th><th>Result</th><th>Net</th><th>Edge</th><th></th></tr></thead><tbody>${bets.map((b,i)=>`<tr>
    <td>${new Date(b.createdAt).toLocaleDateString()}</td><td>${escapeHtml(b.kind||"PREGAME")}</td><td>${escapeHtml(b.away)} @ ${escapeHtml(b.home)}</td><td>${escapeHtml(b.team)}</td><td>${fmtLine(b.line)}</td><td>${fmtPrice(b.price)}</td><td>${Number(b.stake)>0?`$${Number(b.stake).toFixed(2)}`:"—"}</td><td>${resultPill(b)}</td><td>${["WIN","LOSS","PUSH"].includes(b.result)?`${fmtUnits(b.unitsProfit)}${Number.isFinite(Number(b.dollarsProfit))?`<br><small>${Number(b.dollarsProfit)<0?"-":""}$${Math.abs(Number(b.dollarsProfit)).toFixed(2)}</small>`:""}`:"—"}</td><td>${b.edge===null||b.edge===undefined?"—":`${Number(b.edge)>=0?"+":""}${Number(b.edge).toFixed(1)}`}</td><td><button class="small-btn" onclick="removeBet(${i})">Remove</button></td>
  </tr>`).join("")}</tbody></table>`;
}
function removeBet(i){const b=getBets();b.splice(i,1);saveBets(b);} window.removeBet=removeBet;

async function checkBetResults(){
  const btn=$("checkBetResultsBtn"), status=$("betCheckStatus"), bets=getBets();
  if(!bets.length){status.textContent="No tracked bets to check.";return;}
  btn.disabled=true; status.textContent="Checking completed games…";
  try{
    const payload=bets.map(b=>({id:b.id,kind:b.kind,gameId:b.gameId,cfbdGameId:b.cfbdGameId,team:b.team,line:b.line,price:b.price,units:b.units,stake:b.stake,away:b.away,home:b.home}));
    const res=await fetch(BET_CHECK_ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({bets:payload})});
    const data=await res.json();
    if(!res.ok)throw new Error(data?.error||`Result check failed (${res.status})`);
    const byId=new Map((data.results||[]).map(r=>[String(r.id),r]));
    let newly=0;
    bets.forEach(b=>{
      const r=byId.get(String(b.id)); if(!r||r.status!=="GRADED")return;
      if(!["WIN","LOSS","PUSH"].includes(b.result))newly++;
      b.result=r.result; b.atsMargin=r.atsMargin; b.unitsProfit=r.unitsProfit; b.dollarsProfit=r.dollarsProfit; b.finalScore=r.finalScore; b.closingLine=r.closingLine; b.clv=r.clv; b.gradedAt=r.gradedAt; b.gradeSource=r.source;
    });
    saveBets(bets);
    status.textContent=`Checked ${data.checked||bets.length} wagers • ${data.graded||0} completed • ${data.pending||0} pending${newly?` • ${newly} newly graded`:""}.`;
  }catch(e){status.textContent=`⚠ ${e.message||e}`;}
  finally{btn.disabled=false;}
}
function exportBets(){
  const blob=new Blob([JSON.stringify({version:"Saturday Edge BetMGM Ledger v0.1",exportedAt:new Date().toISOString(),bets:getBets()},null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`saturday-edge-betmgm-ledger-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function importBetsFile(file){
  const reader=new FileReader();reader.onload=()=>{try{const parsed=JSON.parse(reader.result);const incoming=Array.isArray(parsed)?parsed:parsed?.bets;if(!Array.isArray(incoming))throw new Error("No bets array found.");const current=getBets();const seen=new Set(current.map(b=>b.id));for(const row of incoming){if(!row.id)row.id=makeBetId();if(!seen.has(row.id)){current.push(row);seen.add(row.id);}}current.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));saveBets(current);$("betCheckStatus").textContent=`Imported ${incoming.length} ledger rows. Duplicate IDs were skipped.`;}catch(e){alert(`Could not import ledger: ${e.message||e}`);}};reader.readAsText(file);
}
function openBetMgm(){window.open(BETMGM_URL,"_blank","noopener,noreferrer");} window.openBetMgm=openBetMgm;

$("betForm").addEventListener("submit",e=>{
  e.preventDefault(); if(!currentBetGame) return;
  const g=currentBetGame,bets=getBets();
  const team=$("betTeam").value, stake=$("betStake").value===""?null:Number($("betStake").value);
  if(currentBetKind==="LIVE"){
    const lm=g.liveModel||{};
    const isRec=teamNamesMatch(team,lm.recommendedTeam);
    const edge=lm.edge===null||lm.edge===undefined?null:(isRec?Number(lm.edge):-Number(lm.edge));
    const fair=lm.fairLineForRecommendedTeam===null||lm.fairLineForRecommendedTeam===undefined?null:(isRec?Number(lm.fairLineForRecommendedTeam):-Number(lm.fairLineForRecommendedTeam));
    bets.unshift({id:makeBetId(),kind:"LIVE",result:"PENDING",createdAt:new Date().toISOString(),gameId:g.gameId,cfbdGameId:g.cfbdGameId,season:g.season??null,week:g.week??null,kickoff:g.kickoff,away:g.away,home:g.home,team,line:Number($("betLine").value),price:Number($("betPrice").value),units:Number($("betUnits").value),stake,edge,projectedLine:fair,classification:lm.signal||"TRACK_ONLY",gameState:liveGameState(g),scoreAtBet:`${g.awayScore??"—"}-${g.homeScore??"—"}`,possession:g.possession??null,pregameClose:lm.pregameCloseForRecommendedTeam??null,notes:$("betNotes").value.trim()});
  }else{
    bets.unshift({id:makeBetId(),kind:"PREGAME",result:"PENDING",createdAt:new Date().toISOString(),gameId:g.id,cfbdGameId:g.cfbdGameId??null,season:g.season??null,week:g.week??null,kickoff:g.kickoff,away:g.away,home:g.home,team,line:Number($("betLine").value),price:Number($("betPrice").value),units:Number($("betUnits").value),stake,edge:Number(g.edge),edgeScore:Number(g.edgeScore),projectedLine:Number(g.projectedLine),classification:g.classification,consensusLine:g.marketConsensus?.consensusLine??null,betmgmVsConsensus:g.marketConsensus?.betmgmVsConsensus??null,matchedSystems:g.matchedSystems||[],notes:$("betNotes").value.trim()});
  }
  saveBets(bets); $("betDialog").close();
});

function openSettings(){ $("modeSelect").value=settings.mode; $("endpointInput").value=settings.endpoint||""; $("liveEndpointInput").value=settings.liveEndpoint||LIVE_EDGE_ENDPOINT; $("settingsDialog").showModal(); }
$("saveSettingsBtn").addEventListener("click",async()=>{
  settings={version:SETTINGS_VERSION,mode:$("modeSelect").value,endpoint:$("endpointInput").value.trim(),liveEndpoint:$("liveEndpointInput").value.trim()||LIVE_EDGE_ENDPOINT};
  localStorage.setItem("se-settings",JSON.stringify(settings)); $("settingsDialog").close();
  await loadGames();
  await loadPerformance();
  if(activeView==="live") await loadLiveGames();
});
$("tabs").addEventListener("click",e=>{
  const btn=e.target.closest(".tab");
  if(!btn)return;
  $("tabs").querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
  btn.classList.add("active");
  currentFilter=btn.dataset.filter;
  render();
});

$("shadowTabs").addEventListener("click",e=>{
  const btn=e.target.closest(".shadow-tab");
  if(!btn)return;
  $("shadowTabs").querySelectorAll(".shadow-tab").forEach(x=>x.classList.remove("active"));
  btn.classList.add("active");
  currentShadowFilter=btn.dataset.shadowFilter;
  render();
});

$("timeTabs").addEventListener("click",e=>{
  const btn=e.target.closest(".time-tab");
  if(!btn)return;
  $("timeTabs").querySelectorAll(".time-tab").forEach(x=>x.classList.remove("active"));
  btn.classList.add("active");
  currentTimeFilter=btn.dataset.timeFilter;

  // Once a kickoff window is selected, chronological order is usually
  // the most useful view. "All day" leaves the user's current sort alone.
  if(currentTimeFilter!=="ALL"){
    $("sortSelect").value="time";
  }
  render();
});

$("sortSelect").addEventListener("change",render);
$("refreshBtn").addEventListener("click",async()=>{
  if(activeView==="live"){
    await loadLiveGames();
  }else{
    await loadGames();
    await loadPerformance();
  }
});
$("liveRefreshBtn").addEventListener("click",loadLiveGames);
$("pregameViewBtn").addEventListener("click",()=>switchView("pregame"));
$("liveViewBtn").addEventListener("click",()=>switchView("live"));
$("settingsBtn").addEventListener("click",openSettings);
$("dialogClose").addEventListener("click",()=>$("gameDialog").close());
$("settingsClose").addEventListener("click",()=>$("settingsDialog").close());
$("betDialogClose").addEventListener("click",()=>$("betDialog").close());
$("openBetMgmBtn").addEventListener("click",openBetMgm);
$("checkBetResultsBtn").addEventListener("click",checkBetResults);
$("exportBetsBtn").addEventListener("click",exportBets);
$("importBetsBtn").addEventListener("click",()=>$("importBetsFile").click());
$("importBetsFile").addEventListener("change",e=>{const file=e.target.files?.[0];if(file)importBetsFile(file);e.target.value="";});
$("clearBetsBtn").addEventListener("click",()=>{if(confirm("Clear every wager from the local BetMGM ledger?")){saveBets([]);}});

function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}

if("serviceWorker" in navigator){window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js?v=71a").catch(()=>{}));}
(async()=>{
  renderLiveBets();
  renderBetMgmPerformance();
  await loadGames();
  await loadPerformance();
})();
