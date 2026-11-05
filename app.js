const LIVE_ENDPOINT = "https://ahskdtpxsjqasbpbvxja.supabase.co/functions/v1/saturday-edge-board";
const PERFORMANCE_ENDPOINT = "https://ahskdtpxsjqasbpbvxja.supabase.co/functions/v1/saturday-edge-performance";
const LIVE_EDGE_ENDPOINT = "https://ahskdtpxsjqasbpbvxja.supabase.co/functions/v1/Saturday-edge-live";
const BET_CHECK_ENDPOINT = "https://ahskdtpxsjqasbpbvxja.supabase.co/functions/v1/Saturday-edge-bet-check";
const BETMGM_URL = "https://sports.betmgm.com/";
const SETTINGS_VERSION = 18;
const LIVE_AUTO_REFRESH_MS = 2 * 60 * 1000;
const DEFAULT_SUPABASE_URL = "https://ahskdtpxsjqasbpbvxja.supabase.co";
const CLOUD_TABLE = "se_user_bets";

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

const defaultSettings = { version:SETTINGS_VERSION, mode:"live", endpoint:LIVE_ENDPOINT, liveEndpoint:LIVE_EDGE_ENDPOINT, supabaseUrl:DEFAULT_SUPABASE_URL, supabaseKey:"" };

function loadSettings(){
  try{
    const saved = JSON.parse(localStorage.getItem("se-settings") || "{}");
    if(saved.version !== SETTINGS_VERSION){
      const upgraded={...defaultSettings,...saved,version:SETTINGS_VERSION};
      localStorage.setItem("se-settings", JSON.stringify(upgraded));
      return upgraded;
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
let currentEditingBetId = null;
let currentLedgerSportFilter = "ALL";
let currentBetSlipFile = null;
let currentBetSlipObjectUrl = null;
let betSlipOcrBusy = false;
const SHARE_CACHE = "saturday-edge-share-v1";
const SHARED_BET_SLIP_KEY = "./shared-bet-slip";
const SHARED_HISTORY_TEXT_KEY = "./shared-history-text";
let historyImportCandidates = [];
let historyOcrBusy = false;

const EDGE_SPORTS = {
  CFB:{label:"College Football",short:"CFB",icon:"🏈",grader:true},
  NFL:{label:"NFL",short:"NFL",icon:"🏈",grader:false},
  CBB:{label:"College Basketball",short:"CBB",icon:"🏀",grader:false},
  NBA:{label:"NBA",short:"NBA",icon:"🏀",grader:false},
  INTL:{label:"International Basketball",short:"INTL",icon:"🌍",grader:false}
};
function normalizeSport(value){
  const s=String(value||"CFB").toUpperCase();
  return EDGE_SPORTS[s]?s:"CFB";
}
function sportMeta(value){ return EDGE_SPORTS[normalizeSport(value)]; }
function sportBadge(value){
  const s=normalizeSport(value),m=sportMeta(s);
  return `<span class="sport-pill ${s.toLowerCase()}">${m.icon} ${m.short}</span>`;
}
let lastPayload = null;
let performance = null;
let activeView = "pregame";
let liveGames = [];
let livePayload = null;
let liveAutoTimer = null;
let pregameStatusText = "";
let liveStatusText = "Live Edge is ready.";
let cloudClient = null;
let cloudSession = null;
let cloudUser = null;
let cloudSyncBusy = false;
let cloudPushTimer = null;
let cloudLastSyncAt = null;

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
  const rows=getBets().filter(b=>b.kind==="LIVE"&&normalizeSport(b.sport)==="CFB");
  $("liveBetCount").textContent=rows.length;
  $("liveUnitsRisked").textContent=`${rows.reduce((sum,b)=>sum+Number(b.units||0),0).toFixed(1)}u`;
  if(!rows.length){$("liveBetsTableWrap").innerHTML=`<div class="empty">No in-game BetMGM wagers tracked yet. Use “+ Bet Placed” on a live card.</div>`;return;}
  $("liveBetsTableWrap").innerHTML=`<table class="bets-table"><thead><tr><th>Time</th><th>Game</th><th>State</th><th>Side</th><th>Line</th><th>Stake</th><th>Result</th><th>Net</th><th>Live edge</th><th>Actions</th></tr></thead><tbody>${rows.map(b=>`<tr>
    <td>${new Date(b.createdAt).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</td><td>${escapeHtml(b.away)} @ ${escapeHtml(b.home)}</td><td>${escapeHtml(b.gameState||"LIVE")}<br><small>${escapeHtml(b.scoreAtBet||"")}</small></td><td>${escapeHtml(b.team)} ${fmtLine(b.line)}<br><small>${fmtPrice(b.price)}</small></td><td>${fmtLine(b.line)}</td><td>${Number(b.stake)>0?`$${Number(b.stake).toFixed(2)}`:`${Number(b.units).toFixed(1)}u`}</td><td>${resultPill(b)}</td><td>${["WIN","LOSS","PUSH"].includes(b.result)?fmtUnits(b.unitsProfit):"—"}</td><td>${b.edge===null||b.edge===undefined?"—":`${Number(b.edge)>=0?"+":""}${Number(b.edge).toFixed(1)}`}</td><td><div class="bet-row-actions">${String(b.result||"PENDING").toUpperCase()==="PENDING"&&normalizeSport(b.sport)!=="CFB"?`<button class="small-btn settle" onclick="openSettleBet('${escapeHtml(b.id)}')">Settle</button>`:""}<button class="small-btn" onclick="openEditBet('${escapeHtml(b.id)}')">Edit</button><button class="small-btn danger" onclick="deleteBet('${escapeHtml(b.id)}')">Delete</button></div></td>
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

function localDateTimeValue(d=new Date()){
  const pad=n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function isoToLocalDateTimeValue(value){
  const d=value?new Date(value):new Date();
  return Number.isNaN(d.getTime())?localDateTimeValue():localDateTimeValue(d);
}
function sameKickoffMinute(a,b){
  const x=new Date(a).getTime(), y=new Date(b).getTime();
  return Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-y)<60000;
}
function manualGameId(away,home,kickoff,sport="CFB"){
  const slug=v=>String(v||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,36);
  const day=kickoff?String(kickoff).slice(0,10):new Date().toISOString().slice(0,10);
  return `manual-${normalizeSport(sport).toLowerCase()}-${slug(away)}-${slug(home)}-${day}`;
}
function updateManualSportHint(){
  const s=normalizeSport($("manualSport")?.value);
  if(!$("manualSportHint")) return;
  $("manualSportHint").textContent=s==="CFB"
    ?"CFB wagers use the current automatic result checker."
    :`${sportMeta(s).label} wagers sync across devices now. Until its automatic grader is ready, use Settle after the game ends.`;
}
function openManualBet(){
  $("manualSport").value="CFB";
  $("manualCompetition").value="";
  updateManualSportHint();
  $("manualBetKind").value="PREGAME";
  $("manualAway").value=""; $("manualHome").value=""; $("manualTeam").value="";
  $("manualLine").value=""; $("manualPrice").value="-110"; $("manualUnits").value="1"; $("manualStake").value="";
  $("manualKickoff").value=localDateTimeValue(); $("manualScoreAtBet").value=""; $("manualGameState").value=""; $("manualNotes").value="";
  $("manualLiveFields").classList.add("hidden");
  $("manualBetDialog").showModal();
}
function syncManualBetKind(){
  $("manualLiveFields").classList.toggle("hidden",$("manualBetKind").value!=="LIVE");
}
window.openManualBet=openManualBet;


function normalizeOcrText(text){
  return String(text||"")
    .replace(/[“”]/g,'"')
    .replace(/[’]/g,"'")
    .replace(/\r/g,"\n")
    .replace(/[ \t]+/g," ")
    .replace(/\n{3,}/g,"\n\n")
    .trim();
}
function ocrLines(text){
  return normalizeOcrText(text).split("\n").map(x=>x.trim()).filter(x=>x.length>1);
}
function detectCompetition(text){
  const t=String(text||"");
  const leagues=[
    [/euroleague/i,"EuroLeague"],[/eurocup/i,"EuroCup"],[/fiba/i,"FIBA"],
    [/basketball champions league/i,"Basketball Champions League"],
    [/liga acb|acb league/i,"Liga ACB"],[/aba league/i,"ABA League"],
    [/greek basket league/i,"Greek Basket League"],[/turkish basketball super league|\bbsl\b/i,"Turkish BSL"],
    [/nbl australia/i,"NBL Australia"],[/british basketball league|\bbbl\b/i,"British Basketball League"]
  ];
  return leagues.find(([rx])=>rx.test(t))?.[1]||"";
}
function detectSportsbook(text){
  const t=String(text||"");
  const books=[
    [/bet\s*mgm|betmgm/i,"BetMGM"],
    [/draft\s*kings|draftkings/i,"DraftKings"],
    [/fan\s*duel|fanduel/i,"FanDuel"],
    [/caesars/i,"Caesars"],
    [/espn\s*bet/i,"ESPN BET"],
    [/fanatics/i,"Fanatics Sportsbook"]
  ];
  return books.find(([rx])=>rx.test(t))?.[1]||"";
}
const NFL_TEAM_NAMES = [
  "Arizona Cardinals","Atlanta Falcons","Baltimore Ravens","Buffalo Bills","Carolina Panthers","Chicago Bears",
  "Cincinnati Bengals","Cleveland Browns","Dallas Cowboys","Denver Broncos","Detroit Lions","Green Bay Packers",
  "Houston Texans","Indianapolis Colts","Jacksonville Jaguars","Kansas City Chiefs","Las Vegas Raiders",
  "Los Angeles Chargers","LA Chargers","Los Angeles Rams","LA Rams","Miami Dolphins","Minnesota Vikings",
  "New England Patriots","New Orleans Saints","New York Giants","NY Giants","New York Jets","NY Jets",
  "Philadelphia Eagles","Pittsburgh Steelers","San Francisco 49ers","Seattle Seahawks","Tampa Bay Buccaneers",
  "Tennessee Titans","Washington Commanders"
];
const NBA_TEAM_NAMES = [
  "Atlanta Hawks","Boston Celtics","Brooklyn Nets","Charlotte Hornets","Chicago Bulls","Cleveland Cavaliers",
  "Dallas Mavericks","Denver Nuggets","Detroit Pistons","Golden State Warriors","Houston Rockets","Indiana Pacers",
  "LA Clippers","Los Angeles Clippers","Los Angeles Lakers","Memphis Grizzlies","Miami Heat","Milwaukee Bucks",
  "Minnesota Timberwolves","New Orleans Pelicans","New York Knicks","Oklahoma City Thunder","Orlando Magic",
  "Philadelphia 76ers","Phoenix Suns","Portland Trail Blazers","Sacramento Kings","San Antonio Spurs",
  "Toronto Raptors","Utah Jazz","Washington Wizards"
];
function containsKnownTeam(text,names){
  const t=String(text||"").toLowerCase();
  return names.some(name=>t.includes(name.toLowerCase()));
}
function detectBetSport(text){
  const t=String(text||"").toLowerCase();

  if(/\beuroleague\b|\beurocup\b|\bfiba\b|basketball champions league|liga acb|acb league|lega basket|serie a basketball|aba league|greek basket league|turkish basketball super league|\bbsl\b|\bnbl australia\b|british basketball league|\bbbl\b/i.test(t)) return "INTL";
  if(/\bncaab\b|\bncaam\b|college basketball|men'?s college basketball|women'?s college basketball|march madness/.test(t)) return "CBB";
  if(/\bnba\b|national basketball association/.test(t)) return "NBA";
  if(/\bnfl\b|national football league/.test(t)) return "NFL";
  if(/\bncaaf\b|\bcfb\b|college football|ncaa football/.test(t)) return "CFB";

  if(containsKnownTeam(t,NFL_TEAM_NAMES)) return "NFL";
  if(containsKnownTeam(t,NBA_TEAM_NAMES)) return "NBA";

  return "";
}
function detectBetKind(text){
  return /\blive\b|in[\s-]?game|live bet|q[1-4]\b|quarter\s*[1-4]|halftime|2nd half|second half/i.test(String(text||"")) ? "LIVE" : "PREGAME";
}
function parseAmericanOdds(text){
  const t=String(text||"");
  const labeled=t.match(/(?:odds|price|american odds)[^\n+\-]{0,14}([+\-]\d{3,4})/i);
  if(labeled) return Number(labeled[1]);
  const all=[...t.matchAll(/(?:^|[\s(])([+\-]\d{3,4})(?=$|[\s)])/g)]
    .map(m=>Number(m[1])).filter(n=>Math.abs(n)>=100&&Math.abs(n)<=5000);
  return all.length?all[0]:null;
}
function parseStakeAmount(text){
  const t=String(text||"");
  const patterns=[
    /(?:stake|wager(?:ed)?|risk|bet amount|amount wagered)\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\$\s*([\d,]+(?:\.\d{2}))\s*(?:stake|wager|risk)/i
  ];
  for(const rx of patterns){
    const m=t.match(rx);
    if(m){const n=Number(m[1].replace(/,/g,""));if(Number.isFinite(n))return n;}
  }
  return null;
}
function cleanTeamName(v){
  return String(v||"")
    .replace(/\b(?:spread|point spread|moneyline|total|alternate spread|alt spread)\b/ig," ")
    .replace(/[|•]+/g," ")
    .replace(/\s{2,}/g," ")
    .replace(/^[\s\-:]+|[\s\-:]+$/g,"")
    .trim();
}
function plausibleTeamName(v){
  const s=cleanTeamName(v);
  if(s.length<2||s.length>55||!/[A-Za-z]/.test(s)) return false;
  if(/\$|odds|stake|wager|payout|potential|receipt|ticket|placed|selection|straight bet|single bet|spread|moneyline|total|sportsbook|account|cash out|open bets|settled/i.test(s)) return false;
  if(/^\d/.test(s)) return false;
  return true;
}
function parseSpreadSelection(lines,text){
  const candidates=[];
  const patterns=[
    /^(.{2,55}?)\s+([+\-]\d{1,2}(?:\.\d+)?)\s*(?:\(?([+\-]\d{3,4})\)?)?\s*$/,
    /^(.{2,55}?)\s+(?:spread\s*)?([+\-]\d{1,2}(?:\.\d+)?)\b/i
  ];
  lines.forEach((line,idx)=>{
    for(const rx of patterns){
      const m=line.match(rx);
      if(!m)continue;
      const team=cleanTeamName(m[1]), spread=Number(m[2]);
      if(!plausibleTeamName(team)||!Number.isFinite(spread)||Math.abs(spread)>70)continue;
      const price=m[3]?Number(m[3]):null;
      candidates.push({team,line:spread,price:Number.isFinite(price)?price:null,idx,raw:line});
      break;
    }
  });
  if(candidates.length){
    const preferred=candidates.find(x=>/\bspread\b/i.test(x.raw))||candidates[0];
    return preferred;
  }
  const inline=String(text||"").match(/([A-Za-z][A-Za-z .&'’\-]{2,45}?)\s+([+\-]\d{1,2}(?:\.\d+)?)\s+(?:[+\-]\d{3,4})/);
  if(inline){
    const team=cleanTeamName(inline[1]), spread=Number(inline[2]);
    if(plausibleTeamName(team)&&Number.isFinite(spread)&&Math.abs(spread)<=70) return {team,line:spread,price:null,idx:-1,raw:inline[0]};
  }
  return null;
}
function parseMatchup(lines,selection){
  for(const line of lines){
    const m=line.match(/^(.{2,55}?)\s+(?:@|at|vs\.?|versus|v\.)\s+(.{2,55}?)$/i);
    if(m){
      const a=cleanTeamName(m[1]),h=cleanTeamName(m[2]);
      if(plausibleTeamName(a)&&plausibleTeamName(h)) return {away:a,home:h};
    }
  }
  if(selection&&selection.idx>=0){
    const nearby=[];
    for(let d=-4;d<=4;d++){
      if(!d)continue;
      const v=lines[selection.idx+d];
      if(v&&plausibleTeamName(v)&&!v.includes(selection.team)) nearby.push(cleanTeamName(v));
    }
    if(nearby.length){
      const opp=nearby[0];
      return {away:selection.team,home:opp};
    }
  }
  return {away:"",home:""};
}
function parseTicketDateTime(lines){
  const now=new Date();
  const month=/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/i;
  const dateNum=/\b\d{1,2}[\/\-]\d{1,2}[\/\-](?:\d{2}|\d{4})\b/;
  const time=/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i;
  for(let i=0;i<lines.length;i++){
    const parts=[lines[i],lines[i+1]].filter(Boolean);
    const joined=parts.join(" ");
    if((month.test(joined)||dateNum.test(joined))&&time.test(joined)){
      let candidate=joined.replace(/\bat\b/i," ");
      if(month.test(candidate)&&!/\b20\d{2}\b/.test(candidate)) candidate=`${candidate} ${now.getFullYear()}`;
      const d=new Date(candidate);
      if(!Number.isNaN(d.getTime())) return isoToLocalDateTimeValue(d.toISOString());
    }
  }
  return "";
}
function parseBetSlipText(text){
  const clean=normalizeOcrText(text),lines=ocrLines(clean);
  const selection=parseSpreadSelection(lines,clean);
  const matchup=parseMatchup(lines,selection);
  const sportsbook=detectSportsbook(clean);
  const price=selection?.price??parseAmericanOdds(clean);
  const stake=parseStakeAmount(clean);
  const kickoff=parseTicketDateTime(lines);
  const confidence=[
    selection?.team?1:0,
    Number.isFinite(selection?.line)?1:0,
    Number.isFinite(price)?1:0,
    sportsbook?0.5:0,
    matchup.away&&matchup.home?1:0,
    kickoff?0.5:0
  ].reduce((a,b)=>a+b,0);
  return {
    sport:detectBetSport(clean),
    kind:detectBetKind(clean),
    sportsbook,
    competition:detectCompetition(clean),
    away:matchup.away||"",
    home:matchup.home||"",
    team:selection?.team||"",
    line:Number.isFinite(selection?.line)?selection.line:null,
    price:Number.isFinite(price)?price:-110,
    stake:Number.isFinite(stake)?stake:null,
    kickoff,
    rawText:clean,
    confidence
  };
}

function historyTicketId(text){
  const m=String(text||"").match(/(?:bet\s*slip|bet|ticket|wager)\s*(?:id|#|number|no\.?)\s*:?\s*([A-Z0-9\-]{5,})/i);
  return m?m[1]:null;
}
function historyPayout(text){
  const m=String(text||"").match(/payout\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if(!m)return null;
  const n=Number(m[1].replace(/,/g,""));
  return Number.isFinite(n)?n:null;
}
function historyPlacedAt(lines){
  const date=/\b(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\b/;
  const time=/\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/i;
  for(const line of [...lines].reverse()){
    if(!/\bTN\b/i.test(line))continue;
    const dm=line.match(date),tm=line.match(time);
    if(!dm||!tm)continue;
    const d=new Date(`${dm[1]} ${tm[1]}`);
    if(!Number.isNaN(d.getTime()))return d.toISOString();
  }
  return null;
}
function parseBetMgmSelectionLine(line){
  const s=String(line||"").trim();
  const m=s.match(/^(.{2,70}?)\s+([+\-]\d{1,2}(?:\.\d+)?)\b(.*)$/);
  if(!m)return null;
  const team=cleanTeamName(m[1]),spread=Number(m[2]),tail=m[3]||"";
  if(!plausibleTeamName(team)||!Number.isFinite(spread)||Math.abs(spread)>70)return null;
  const prices=[...tail.matchAll(/([+\-]\d{3,4})\b/g)].map(x=>Number(x[1])).filter(Number.isFinite);
  // BetMGM boost cards can show crossed-out old odds followed by the new odds.
  // The right-most/last price is the active one.
  const price=prices.length?prices[prices.length-1]:null;
  return {team,line:spread,price,raw:s};
}
function isHistoryResultLine(line){
  return /^(won|winner|win|lost|loss|loser|push|pushed|void|voided|cancelled|canceled|refunded)$/i.test(String(line||"").trim());
}
function isHistoryTicketLine(line){
  return /(?:bet\s*slip|ticket|wager)\s*(?:id|#|number|no\.?)?\s*:?\s*[A-Z0-9\-]{5,}/i.test(String(line||""));
}
function splitBetMgmHistoryCards(text,{requireTicketBoundary=false}={}){
  const lines=ocrLines(text);
  const cards=[];
  let cursor=0;

  // v0.9.4d: Bet slip ID is the hard end-of-card anchor. This prevents an OCR
  // overlap or a missed Lost label from allowing one card's result/team/odds
  // to bleed into the next wager.
  for(let i=0;i<lines.length;i++){
    if(!isHistoryTicketLine(lines[i]))continue;
    const segment=lines.slice(cursor,i+1);
    let localStart=segment.findIndex(isHistoryResultLine);
    if(localStart<0){
      // If OCR missed the colored Won/Lost badge, start near the first spread
      // selection instead of reaching backward into the previous card.
      const spreadIdx=segment.findIndex(x=>/^spread$/i.test(x.trim()));
      if(spreadIdx>0)localStart=Math.max(0,spreadIdx-2);
      else localStart=0;
    }
    const card=segment.slice(localStart);
    if(card.some(x=>/\bspread\b/i.test(x)))cards.push(card);
    cursor=i+1;
  }

  if(cards.length||requireTicketBoundary)return cards;

  // Paste-text fallback for books/screenshots where OCR loses Bet slip ID.
  // Result headers may still define cards, but this path is intentionally not
  // used for overlapping image slices.
  const starts=[];
  lines.forEach((line,i)=>{ if(isHistoryResultLine(line))starts.push(i); });
  for(let j=0;j<starts.length;j++){
    const start=starts[j],end=j+1<starts.length?starts[j+1]:lines.length;
    const card=lines.slice(start,end);
    if(card.some(x=>/\bspread\b/i.test(x)))cards.push(card);
  }
  return cards;
}
function historyResultForCard(card){
  const lines=Array.isArray(card)?card:ocrLines(card);
  const block=lines.join("\n");

  // First choice: an explicit result badge anywhere inside THIS card only.
  const badge=lines.find(isHistoryResultLine);
  if(badge)return historyResult(badge);

  // OCR can miss white text on BetMGM's red/green result badges. On the
  // Settled screen the payout field gives us a safe card-local fallback.
  const stake=parseStakeAmount(block);
  const payout=historyPayout(block);
  if(Number.isFinite(payout)){
    if(Number.isFinite(stake)&&Math.abs(payout-stake)<0.01)return "PUSH";
    if(payout>0)return "WIN";
  }
  if(/payout\s*:?\s*(?:[-—–]|$)/im.test(block))return "LOSS";
  return "PENDING";
}
function parseBetMgmCard(card,index){
  const block=card.join("\n");
  const result=historyResultForCard(card);
  const spreadIdx=card.findIndex(x=>/^spread$/i.test(x.trim()));
  let selection=null;
  if(spreadIdx>0){
    for(let i=spreadIdx-1;i>=0&&i>=spreadIdx-3;i--){
      selection=parseBetMgmSelectionLine(card[i]);
      if(selection)break;
    }
  }
  if(!selection){
    for(const line of card){
      selection=parseBetMgmSelectionLine(line);
      if(selection)break;
    }
  }
  if(!selection)return null;

  let matchupLine="";
  if(spreadIdx>=0){
    for(let i=spreadIdx+1;i<Math.min(card.length,spreadIdx+5);i++){
      if(/(?:\s@|\sat\s|vs\.?|versus)/i.test(card[i])){matchupLine=card[i];break;}
    }
  }
  if(!matchupLine)matchupLine=card.find(x=>/(?:\s@|\sat\s|vs\.?|versus)/i.test(x))||"";

  let neutralSite=/neutral venue/i.test(matchupLine);
  matchupLine=matchupLine.replace(/\s*\(Neutral Venue\)\s*/ig," ").replace(/\s{2,}/g," ").trim();
  const mm=matchupLine.match(/^(.{2,70}?)\s+(?:@|at|vs\.?|versus|v\.)\s+(.{2,70}?)$/i);
  const away=mm?cleanTeamName(mm[1]):"";
  const home=mm?cleanTeamName(mm[2]):"";

  const kickoffLocal=parseTicketDateTime(card);
  const kickoff=kickoffLocal?new Date(kickoffLocal).toISOString():new Date().toISOString();
  const placedAt=historyPlacedAt(card)||kickoff;
  const stake=parseStakeAmount(block);
  const payout=historyPayout(block);
  const ticketId=historyTicketId(block);
  const competition=detectCompetition(block);
  const sport=detectBetSport(block)||detectBetSport(`${away} ${home} ${selection.team}`);
  const unsupported=historyUnsupportedReason(block);
  const complete=Boolean(EDGE_SPORTS[sport]&&away&&home&&selection.team&&Number.isFinite(selection.line)&&Number.isFinite(selection.price));

  return {
    reviewId:`hist-card-${Date.now()}-${index}`,
    ticketId,
    sport:EDGE_SPORTS[sport]?sport:"",
    market:"SPREAD",
    kind:detectBetKind(block),
    result,
    away,home,team:selection.team,line:selection.line,price:Number.isFinite(selection.price)?selection.price:parseAmericanOdds(block)??-110,
    units:1,
    stake:Number.isFinite(stake)?stake:null,
    payout:Number.isFinite(payout)?payout:null,
    kickoff,createdAt:placedAt,
    competition:competition||null,
    neutralSite,
    sportsbook:"BetMGM",importSource:"BETMGM_HISTORY",
    oddsBoost:/odds boost/i.test(block),
    unsupported,complete,raw:block
  };
}
function historyResult(text){
  const t=String(text||"").toLowerCase();
  const m=t.match(/\b(won|winner|win|lost|loss|loser|push|pushed|void|voided|cancelled|canceled|refunded)\b/);
  if(!m)return "PENDING";
  const token=m[1];
  if(["won","winner","win"].includes(token))return "WIN";
  if(["lost","loss","loser"].includes(token))return "LOSS";
  if(["push","pushed"].includes(token))return "PUSH";
  return "VOID";
}
function historyUnsupportedReason(text){
  const t=String(text||"").toLowerCase();
  if(/same game parlay|\bsgp\b|\bparlay\b|accumulator/.test(t)) return "Parlay / SGP";
  if(/\bmoneyline\b|\bmoney line\b/.test(t)) return "Moneyline";
  if(/\btotal\b|\bover\b|\bunder\b/.test(t) && !/\bspread\b/.test(t)) return "Total";
  if(/\bcash(?:ed)?\s*out\b/.test(t)) return "Cash out";
  return "";
}
function historyTicketKey(b){
  return b?.ticketId ? `ticket:${String(b.ticketId).trim().toLowerCase()}` : null;
}
function historySemanticKey(b){
  const clean=v=>String(v||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  const day=(b?.kickoff||b?.createdAt||"").slice(0,10);
  const stake=Number(b?.stake);
  return [
    b?.sport?normalizeSport(b.sport):"",
    clean(b?.away),clean(b?.home),clean(b?.team),
    Number.isFinite(Number(b?.line))?Number(b.line).toFixed(1):"",
    Number.isFinite(stake)&&stake>0?stake.toFixed(2):"",
    day
  ].join("|");
}
function historyFingerprint(b){
  return historyTicketKey(b)||historySemanticKey(b);
}
function historySameCalendarDay(a,b){
  const da=String(a?.kickoff||a?.createdAt||"").slice(0,10);
  const db=String(b?.kickoff||b?.createdAt||"").slice(0,10);
  return !da||!db||da===db;
}
function historySemanticMatch(a,b){
  const sa=a?.sport?normalizeSport(a.sport):"", sb=b?.sport?normalizeSport(b.sport):"";
  if(sa&&sb&&sa!==sb)return false;
  if(!teamNamesMatch(a?.away,b?.away)||!teamNamesMatch(a?.home,b?.home)||!teamNamesMatch(a?.team,b?.team))return false;
  if(Math.abs(Number(a?.line)-Number(b?.line))>0.01)return false;
  const as=Number(a?.stake),bs=Number(b?.stake);
  if(Number.isFinite(as)&&as>0&&Number.isFinite(bs)&&bs>0&&Math.abs(as-bs)>0.01)return false;
  return historySameCalendarDay(a,b);
}
function findExistingHistoryMatch(candidate,existing,claimedIds=new Set()){
  const ticket=historyTicketKey(candidate);
  if(ticket){
    const direct=existing.find(b=>historyTicketKey(b)===ticket&&!claimedIds.has(String(b.id)));
    if(direct)return direct;
  }
  return existing.find(b=>historySemanticMatch(candidate,b)&&!claimedIds.has(String(b.id)))||null;
}
function findHistoryDuplicates(candidates){
  const existing=getBets();
  const claimed=new Set();
  const batchTickets=new Set();
  const batchSemantic=new Set();

  return candidates.map(c=>{
    const match=findExistingHistoryMatch(c,existing,claimed);
    if(match){
      claimed.add(String(match.id));
      return {...c,duplicate:false,matchExistingId:String(match.id),matchType:historyTicketKey(match)&&historyTicketKey(c)===historyTicketKey(match)?"TICKET":"SEMANTIC"};
    }

    const tk=historyTicketKey(c),sk=historySemanticKey(c);
    const batchDuplicate=(tk&&batchTickets.has(tk))||batchSemantic.has(sk);
    if(tk)batchTickets.add(tk);
    batchSemantic.add(sk);
    return {...c,duplicate:Boolean(batchDuplicate),matchExistingId:null,matchType:null};
  });
}
function allSpreadSelections(lines){
  const found=[];
  const patterns=[
    /^(.{2,70}?)\s+([+\-]\d{1,2}(?:\.\d+)?)\s*(?:\(?([+\-]\d{3,4})\)?)?\s*$/,
    /^(.{2,70}?)\s+(?:spread\s*)?([+\-]\d{1,2}(?:\.\d+)?)\s*(?:\(?([+\-]\d{3,4})\)?)?/i
  ];
  lines.forEach((line,idx)=>{
    for(const rx of patterns){
      const m=line.match(rx);
      if(!m) continue;
      const team=cleanTeamName(m[1]),lineNum=Number(m[2]),price=m[3]?Number(m[3]):null;
      if(!plausibleTeamName(team)||!Number.isFinite(lineNum)||Math.abs(lineNum)>70) continue;
      if(/\b(?:wager|risk|stake|payout|to win|potential return)\b/i.test(team)) continue;
      found.push({team,line:lineNum,price:Number.isFinite(price)?price:null,idx,raw:line});
      break;
    }
  });
  const deduped=[];
  const seen=new Set();
  for(const item of found){
    const key=`${item.idx}|${item.team.toLowerCase()}|${item.line}`;
    if(seen.has(key))continue;
    seen.add(key);deduped.push(item);
  }
  return deduped;
}
function historyWindow(lines,idx,radius=8){
  return lines.slice(Math.max(0,idx-radius),Math.min(lines.length,idx+radius+1));
}
function matchupNearSelection(lines,sel){
  const start=Math.max(0,sel.idx-8),end=Math.min(lines.length,sel.idx+9);
  const win=lines.slice(start,end);
  for(const line of win){
    const m=line.match(/^(.{2,60}?)\s+(?:@|at|vs\.?|versus|v\.)\s+(.{2,60}?)$/i);
    if(m){
      const away=cleanTeamName(m[1]),home=cleanTeamName(m[2]);
      if(plausibleTeamName(away)&&plausibleTeamName(home))return {away,home};
    }
  }
  const names=win.map(cleanTeamName).filter(plausibleTeamName).filter(v=>!teamNamesMatch(v,sel.team));
  return {away:"",home:names[0]||""};
}
function parseBetMgmHistoryText(text,{requireTicketBoundary=false}={}){
  const clean=normalizeOcrText(text);

  // Prefer BetMGM's actual card structure. v0.9.4d uses Bet slip ID as the
  // hard card boundary, then resolves Won/Lost/Push only inside that card.
  const cards=splitBetMgmHistoryCards(clean,{requireTicketBoundary});
  if(cards.length){
    const parsed=cards.map((card,index)=>parseBetMgmCard(card,index)).filter(Boolean);
    return findHistoryDuplicates(parsed);
  }
  if(requireTicketBoundary)return [];

  // Fallback for pasted OCR that loses both Bet slip IDs and Won/Lost headers.
  const lines=ocrLines(clean);
  const selections=allSpreadSelections(lines);
  const candidates=selections.map((sel,index)=>{
    const win=historyWindow(lines,sel.idx,10);
    const block=win.join("\n");
    const unsupported=historyUnsupportedReason(block);
    const matchup=matchupNearSelection(lines,sel);
    const sport=detectBetSport(block)||detectBetSport(`${matchup.away} ${matchup.home} ${sel.team}`);
    const price=Number.isFinite(sel.price)?sel.price:parseAmericanOdds(block);
    const stake=parseStakeAmount(block);
    const payout=historyPayout(block);
    const kickoffLocal=parseTicketDateTime(win);
    const kickoff=kickoffLocal?new Date(kickoffLocal).toISOString():new Date().toISOString();
    const result=historyResult(block);
    const ticketId=historyTicketId(block);
    const competition=detectCompetition(block);
    const away=matchup.away||"";
    const home=matchup.home||"";
    const complete=Boolean(EDGE_SPORTS[sport]&&away&&home&&sel.team&&Number.isFinite(sel.line)&&Number.isFinite(price));
    return {
      reviewId:`hist-${Date.now()}-${index}`,
      ticketId,
      sport:EDGE_SPORTS[sport]?sport:"",
      market:"SPREAD",
      kind:detectBetKind(block),
      result,
      away,home,team:sel.team,line:sel.line,price:Number.isFinite(price)?price:-110,
      units:1,stake:Number.isFinite(stake)?stake:null,payout:Number.isFinite(payout)?payout:null,
      kickoff,createdAt:historyPlacedAt(win)||kickoff,competition:competition||null,
      sportsbook:"BetMGM",importSource:"BETMGM_HISTORY",
      oddsBoost:/odds boost/i.test(block),
      unsupported,complete,raw:block
    };
  });
  return findHistoryDuplicates(candidates);
}
function historyResultOptions(value){
  return ["PENDING","WIN","LOSS","PUSH"].map(v=>`<option value="${v}" ${v===value?"selected":""}>${v}</option>`).join("");
}
function historySportOptions(value){
  return [
    ["","Choose…"],["CFB","🏈 CFB"],["NFL","🏈 NFL"],["CBB","🏀 CBB"],["NBA","🏀 NBA"],["INTL","🌍 INTL"]
  ].map(([v,l])=>`<option value="${v}" ${v===value?"selected":""}>${l}</option>`).join("");
}
function renderHistoryReview(){
  const list=$("historyReviewList"),btn=$("importSelectedHistoryBtn");
  if(!historyImportCandidates.length){
    list.innerHTML=`<div class="empty">No spread wagers detected yet.</div>`;
    $("historyReviewTitle").textContent="No wagers scanned yet";
    $("historyImportSummary").textContent="Nothing has been added to your ledger.";
    btn.disabled=true;return;
  }
  let cleanCount=0,dupCount=0,blockedCount=0,matchCount=0;
  list.innerHTML=historyImportCandidates.map((c,i)=>{
    const blocked=Boolean(c.unsupported),dup=Boolean(c.duplicate),matched=Boolean(c.matchExistingId);
    const ready=c.complete&&!blocked&&!dup;
    if(ready)cleanCount++; if(dup)dupCount++; if(blocked)blockedCount++; if(matched)matchCount++;
    const status=matched?"MATCH • UPDATE":dup?"DUPLICATE":blocked?`SKIP • ${c.unsupported}`:c.complete?"READY":"REVIEW";
    const statusClass=dup||blocked?"bad":matched?"match":c.complete?"good":"warn";
    const actionLabel=matched?"Update existing":"Import";
    return `<article class="history-review-card ${statusClass}" data-history-index="${i}">
      <div class="history-review-top">
        <label class="history-check"><input class="history-pick" type="checkbox" ${ready?"checked":""} ${dup||blocked?"disabled":""}/> ${actionLabel}</label>
        <span class="history-status ${statusClass}">${escapeHtml(status)}</span>
      </div>
      <div class="history-edit-grid">
        <label>Sport<select class="hr-sport">${historySportOptions(c.sport)}</select></label>
        <label>Result<select class="hr-result">${historyResultOptions(c.result)}</select></label>
        <label>Away<input class="hr-away" value="${escapeHtml(c.away)}" /></label>
        <label>Home<input class="hr-home" value="${escapeHtml(c.home)}" /></label>
        <label>Bet side<input class="hr-team" value="${escapeHtml(c.team)}" /></label>
        <label>Spread<input class="hr-line" type="number" step="0.5" value="${Number.isFinite(c.line)?c.line:""}" /></label>
        <label>Odds<input class="hr-price" type="number" step="1" value="${Number.isFinite(c.price)?c.price:-110}" /></label>
        <label>Stake $<input class="hr-stake" type="number" step="0.01" min="0" value="${Number.isFinite(c.stake)?c.stake:""}" /></label>
        <label>Payout $<input class="hr-payout" type="number" step="0.01" min="0" value="${Number.isFinite(c.payout)?c.payout:""}" /></label>
        <label>League<input class="hr-competition" value="${escapeHtml(c.competition||"")}" /></label>
        <label>Ticket ID<input class="hr-ticket" value="${escapeHtml(c.ticketId||"")}" /></label>
      </div>
      ${(c.oddsBoost||c.neutralSite)?`<div class="history-flags">${c.oddsBoost?`<span>⚡ Odds boost</span>`:""}${c.neutralSite?`<span>🏟 Neutral venue</span>`:""}</div>`:""}
      <details><summary>OCR block</summary><pre>${escapeHtml(c.raw||"")}</pre></details>
    </article>`;
  }).join("");
  $("historyReviewTitle").textContent=`${historyImportCandidates.length} candidate wager${historyImportCandidates.length===1?"":"s"} found`;
  $("historyImportSummary").textContent=`${cleanCount-matchCount} new • ${matchCount} match${matchCount===1?"":"es"} to update • ${dupCount} duplicate${dupCount===1?"":"s"} • ${blockedCount} unsupported. Review checked rows before import.`;
  btn.disabled=false;
}
function collectHistoryReviewRows(){
  return [...$("historyReviewList").querySelectorAll(".history-review-card")].map(card=>{
    const i=Number(card.dataset.historyIndex),base=historyImportCandidates[i]||{};
    const pick=card.querySelector(".history-pick");
    const stakeValue=card.querySelector(".hr-stake").value;
    const payoutValue=card.querySelector(".hr-payout").value;
    return {
      selected:Boolean(pick?.checked&&!pick.disabled),
      data:{
        ...base,
        ticketId:card.querySelector(".hr-ticket").value.trim()||null,
        sport:card.querySelector(".hr-sport").value,
        result:card.querySelector(".hr-result").value,
        away:card.querySelector(".hr-away").value.trim(),
        home:card.querySelector(".hr-home").value.trim(),
        team:card.querySelector(".hr-team").value.trim(),
        line:Number(card.querySelector(".hr-line").value),
        price:Number(card.querySelector(".hr-price").value),
        stake:stakeValue===""?null:Number(stakeValue),
        payout:payoutValue===""?null:Number(payoutValue),
        competition:card.querySelector(".hr-competition").value.trim()||null
      }
    };
  });
}
function refreshHistoryImportButton(){
  const btn=$("importSelectedHistoryBtn");
  if(!btn)return;
  const cards=[...$("historyReviewList").querySelectorAll(".history-review-card")];
  if(!cards.length){btn.disabled=true;return;}

  let selectable=0,selected=0;
  for(const card of cards){
    const pick=card.querySelector(".history-pick");
    if(!pick||pick.disabled)continue;
    selectable++;
    if(pick.checked)selected++;
  }
  // Keep the action available whenever review cards exist. If nothing is
  // selected, clicking it gives a useful message instead of appearing dead.
  btn.disabled=selectable===0;
  btn.textContent=selected?`Import Selected Wagers (${selected})`:"Import Selected Wagers";
}
async function historyImageBitmap(file){
  if(globalThis.createImageBitmap)return await createImageBitmap(file);
  return await new Promise((resolve,reject)=>{
    const img=new Image();
    const url=URL.createObjectURL(file);
    img.onload=()=>{URL.revokeObjectURL(url);resolve(img);};
    img.onerror=e=>{URL.revokeObjectURL(url);reject(e);};
    img.src=url;
  });
}
async function prepareHistoryOcrSlices(file){
  const bmp=await historyImageBitmap(file);
  const w=bmp.width,h=bmp.height;
  const isLong=h/w>2.4;
  const targetWidth=Math.max(1100,Math.min(1500,w*4));
  const scale=targetWidth/w;

  // Normal screenshots stay as one image, but are upscaled if narrow.
  if(!isLong){
    const canvas=document.createElement("canvas");
    canvas.width=Math.round(w*scale);
    canvas.height=Math.round(h*scale);
    const ctx=canvas.getContext("2d");
    ctx.imageSmoothingEnabled=true;
    ctx.imageSmoothingQuality="high";
    ctx.drawImage(bmp,0,0,canvas.width,canvas.height);
    return [{image:canvas,label:"full"}];
  }

  // Very tall scrolling screenshots are sliced into overlapping sections so
  // BetMGM card text remains large enough for OCR. The overlap protects cards
  // that happen to cross a slice boundary.
  const sliceHeight=Math.max(Math.round(w*2.25),420);
  const overlap=Math.max(Math.round(w*.42),90);
  const step=Math.max(200,sliceHeight-overlap);
  const slices=[];
  let y=0,index=1;
  while(y<h){
    const srcH=Math.min(sliceHeight,h-y);
    const canvas=document.createElement("canvas");
    canvas.width=Math.round(w*scale);
    canvas.height=Math.round(srcH*scale);
    const ctx=canvas.getContext("2d");
    ctx.imageSmoothingEnabled=true;
    ctx.imageSmoothingQuality="high";
    ctx.drawImage(bmp,0,y,w,srcH,0,0,canvas.width,canvas.height);
    slices.push({image:canvas,label:`slice ${index}`,y,srcH});
    if(y+srcH>=h)break;
    y+=step;index++;
  }
  return slices;
}

async function scanHistoryImages(files){
  if(historyOcrBusy||!files?.length)return;
  historyOcrBusy=true;
  $("historyImportProgress").classList.remove("hidden");
  $("historyProgressBar").style.width="2%";
  $("historyProgressTitle").textContent=`Reading ${files.length} history image${files.length===1?"":"s"}…`;
  let combined="";
  let allCandidates=[];
  try{
    if(!globalThis.Tesseract?.createWorker)throw new Error("OCR engine did not load.");
    const worker=await Tesseract.createWorker("eng",1,{
      logger:m=>{
        if(m.status)$("historyProgressStatus").textContent=m.status.replace(/_/g," ");
      }
    });

    // Pre-build slices so progress reflects the real amount of OCR work.
    const jobs=[];
    for(let i=0;i<files.length;i++){
      const slices=await prepareHistoryOcrSlices(files[i]);
      slices.forEach((slice,j)=>jobs.push({fileIndex:i,sliceIndex:j,totalSlices:slices.length,...slice}));
    }

    for(let j=0;j<jobs.length;j++){
      const job=jobs[j];
      $("historyProgressStatus").textContent=`Image ${job.fileIndex+1} • ${job.label} • ${j+1}/${jobs.length}`;
      const result=await worker.recognize(job.image);
      const text=result?.data?.text||"";
      combined+=`\n\n===== IMAGE ${job.fileIndex+1} • ${job.label.toUpperCase()} =====\n${text}`;
      const parsed=parseBetMgmHistoryText(text,{requireTicketBoundary:true});
      allCandidates.push(...parsed);
      $("historyProgressBar").style.width=`${Math.round(((j+1)/jobs.length)*100)}%`;
    }
    await worker.terminate();

    $("historyRawText").value=combined.trim();

    // Re-run duplicate/match logic after all slices are combined. Overlapping
    // slices can deliberately see the same BetMGM card twice.
    historyImportCandidates=findHistoryDuplicates(allCandidates);
    renderHistoryReview();

    $("historyProgressTitle").textContent="History scan complete";
    $("historyProgressStatus").textContent=`Read ${jobs.length} enlarged section${jobs.length===1?"":"s"}. Review Stake, Payout, and Result before importing.`;
  }catch(err){
    $("historyProgressTitle").textContent="History scan failed";
    $("historyProgressStatus").textContent=err.message||String(err);
  }finally{historyOcrBusy=false;}
}
function scanPastedHistoryText(text){
  const clean=String(text||"").trim();
  if(!clean){$("historyImportSummary").textContent="Paste some BetMGM history text first.";return;}
  $("historyRawText").value=clean;
  historyImportCandidates=parseBetMgmHistoryText(clean);
  renderHistoryReview();
}
function openBetMgmHistoryImport(){
  $("betMgmHistoryDialog").showModal();
}
async function maybeOpenSharedHistory(){
  const params=new URLSearchParams(location.search);
  if(params.get("importHistory")!=="1"||!("caches" in window))return;
  try{
    const cache=await caches.open(SHARE_CACHE);
    const response=await cache.match(SHARED_HISTORY_TEXT_KEY);
    if(response){
      const text=await response.text();
      await cache.delete(SHARED_HISTORY_TEXT_KEY);
      history.replaceState(null,"",location.pathname);
      $("historyPasteText").value=text;
      openBetMgmHistoryImport();
      scanPastedHistoryText(text);
    }
  }catch(err){console.warn("Shared BetMGM history could not be opened",err);}
}
function historyGradeMoney(b){
  const r=String(b.result||"PENDING").toUpperCase();
  const units=Number(b.units)||1,stake=Number(b.stake),payout=Number(b.payout);
  if(!["WIN","LOSS","PUSH"].includes(r))return b;

  if(r==="WIN"&&Number.isFinite(stake)&&stake>0&&Number.isFinite(payout)&&payout>=stake){
    const cashProfit=payout-stake;
    b.dollarsProfit=cashProfit;
    b.unitsProfit=units*(cashProfit/stake);
  }else{
    b.unitsProfit=r==="WIN"?americanWinProfit(units,b.price):r==="LOSS"?-units:0;
    if(Number.isFinite(stake)&&stake>0)b.dollarsProfit=r==="WIN"?americanWinProfit(stake,b.price):r==="LOSS"?-stake:0;
  }
  if(r==="PUSH"){
    b.unitsProfit=0;
    if(Number.isFinite(stake)&&stake>0)b.dollarsProfit=0;
  }

  b.gradedAt=new Date().toISOString();
  b.gradeSource="BETMGM_HISTORY";
  return b;
}
function applyBetMgmHistoryToExisting(existing,c){
  if(c.ticketId)existing.ticketId=c.ticketId;
  existing.sportsbook="BetMGM";
  existing.importSource=existing.importSource||"BETMGM_HISTORY_MATCH";
  existing.historyMatchedAt=new Date().toISOString();

  if(c.sport&&EDGE_SPORTS[c.sport])existing.sport=c.sport;
  if(c.competition)existing.competition=c.competition;
  if(Number.isFinite(Number(c.price)))existing.price=Number(c.price);
  if(Number.isFinite(Number(c.stake))&&Number(c.stake)>0)existing.stake=Number(c.stake);
  if(Number.isFinite(Number(c.payout)))existing.payout=Number(c.payout);
  existing.neutralSite=Boolean(c.neutralSite||existing.neutralSite);
  existing.oddsBoost=Boolean(c.oddsBoost||existing.oddsBoost);

  if(["WIN","LOSS","PUSH"].includes(String(c.result||"").toUpperCase())){
    existing.result=String(c.result).toUpperCase();
    historyGradeMoney(existing);
  }
  existing.updatedAt=new Date().toISOString();
  return existing;
}
function importReviewedHistory(){
  const reviewed=collectHistoryReviewRows().filter(x=>x.selected);
  if(!reviewed.length){$("historyImportSummary").textContent="Select at least one clean wager to import or update.";return;}

  const bets=getBets();
  let added=0,updated=0,skipped=0;

  for(const row of reviewed){
    const c=row.data;
    if(!EDGE_SPORTS[c.sport]||!c.away||!c.home||!c.team||!Number.isFinite(c.line)||!Number.isFinite(c.price)){skipped++;continue;}

    let idx=c.matchExistingId?bets.findIndex(b=>String(b.id)===String(c.matchExistingId)):-1;
    if(idx<0){
      const match=findExistingHistoryMatch(c,bets);
      idx=match?bets.findIndex(b=>String(b.id)===String(match.id)):-1;
    }

    if(idx>=0){
      bets[idx]=applyBetMgmHistoryToExisting(bets[idx],c);
      updated++;
      continue;
    }

    const isDup=bets.some(b=>{
      const tk=historyTicketKey(c);
      return (tk&&historyTicketKey(b)===tk)||historySemanticMatch(c,b);
    });
    if(isDup){skipped++;continue;}

    const kickoff=c.kickoff||new Date().toISOString();
    const b=historyGradeMoney({
      id:makeBetId(),ticketId:c.ticketId||null,sport:c.sport,competition:c.competition||null,
      market:"SPREAD",kind:c.kind==="LIVE"?"LIVE":"PREGAME",result:c.result||"PENDING",
      manualEntry:true,importSource:"BETMGM_HISTORY",sportsbook:"BetMGM",
      createdAt:c.createdAt||kickoff,kickoff,season:new Date(kickoff).getFullYear(),week:null,
      gameId:manualGameId(c.away,c.home,kickoff,c.sport),cfbdGameId:null,
      away:c.away,home:c.home,team:c.team,line:Number(c.line),price:Number(c.price),
      units:Number(c.units)||1,stake:Number.isFinite(Number(c.stake))?Number(c.stake):null,
      payout:Number.isFinite(Number(c.payout))?Number(c.payout):null,
      neutralSite:Boolean(c.neutralSite),oddsBoost:Boolean(c.oddsBoost),
      edge:null,projectedLine:null,classification:"HISTORY_IMPORT",
      notes:c.ticketId?`BetMGM history • Ticket ${c.ticketId}`:"BetMGM history import"
    });
    bets.push(b);added++;
  }

  bets.sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
  saveBets(bets);
  $("historyImportSummary").textContent=`BetMGM history applied: ${added} new • ${updated} existing updated${skipped?` • ${skipped} skipped`:""}. Cloud sync will carry the changes to your other device.`;
  $("betCheckStatus").textContent=`📚 BetMGM history: ${added} new wager${added===1?"":"s"} • ${updated} existing updated.`;
  if(added||updated){$("importSelectedHistoryBtn").disabled=true;$("importSelectedHistoryBtn").textContent="Imported ✓";}
}
function clearBetSlipPreviewUrl(){
  if(currentBetSlipObjectUrl){URL.revokeObjectURL(currentBetSlipObjectUrl);currentBetSlipObjectUrl=null;}
}
function fillBetSlipImport(parsed){
  $("importSport").value=EDGE_SPORTS[parsed.sport]?parsed.sport:"";
  $("importBetKind").value=parsed.kind==="LIVE"?"LIVE":"PREGAME";
  $("importAway").value=parsed.away||"";
  $("importHome").value=parsed.home||"";
  $("importTeam").value=parsed.team||"";
  $("importLine").value=Number.isFinite(parsed.line)?parsed.line:"";
  $("importPrice").value=Number.isFinite(parsed.price)?parsed.price:-110;
  $("importStake").value=Number.isFinite(parsed.stake)?parsed.stake:"";
  $("importUnits").value="1";
  $("importKickoff").value=parsed.kickoff||localDateTimeValue();
  $("importCompetition").value=parsed.competition||"";
  $("importSportsbook").value=parsed.sportsbook||"";
  $("importNotes").value="";
  $("betSlipRawText").value=parsed.rawText||"";
  const pct=Math.round(Math.min(1,parsed.confidence/5)*100);
  const sportWarning=EDGE_SPORTS[parsed.sport]?"":" Sport is ambiguous, so choose CFB or CBB before saving.";
  $("betSlipConfidence").textContent=pct>=70
    ?`Edge found most of the ticket (${pct}% field confidence). Confirm the matchup and kickoff before saving.${sportWarning}`
    :`Edge found part of the ticket (${pct}% field confidence). Fill any missing fields and confirm everything before saving.${sportWarning}`;
}
async function recognizeBetSlip(file){
  if(!file||betSlipOcrBusy)return;
  currentBetSlipFile=file;betSlipOcrBusy=true;
  clearBetSlipPreviewUrl();
  currentBetSlipObjectUrl=URL.createObjectURL(file);
  $("betSlipPreview").src=currentBetSlipObjectUrl;
  $("betSlipOcrTitle").textContent="Reading bet slip…";
  $("betSlipOcrStatus").textContent="OCR is running on this device.";
  $("betSlipOcrProgress").style.width="4%";
  $("betSlipRawText").value="";
  $("betSlipImportDialog").showModal();
  try{
    if(!globalThis.Tesseract?.createWorker) throw new Error("OCR engine did not load. Check your internet connection and try again.");
    const worker=await Tesseract.createWorker("eng",1,{
      logger:m=>{
        if(m.status)$("betSlipOcrStatus").textContent=m.status.replace(/_/g," ");
        if(Number.isFinite(m.progress))$("betSlipOcrProgress").style.width=`${Math.max(4,Math.round(m.progress*100))}%`;
      }
    });
    const result=await worker.recognize(file);
    await worker.terminate();
    const parsed=parseBetSlipText(result?.data?.text||"");
    fillBetSlipImport(parsed);
    $("betSlipOcrTitle").textContent="Ticket read complete";
    $("betSlipOcrStatus").textContent="Review every field against the screenshot.";
    $("betSlipOcrProgress").style.width="100%";
  }catch(err){
    $("betSlipOcrTitle").textContent="Could not read ticket automatically";
    $("betSlipOcrStatus").textContent=err.message||String(err);
    $("betSlipConfidence").textContent="You can still enter the ticket manually from this confirmation screen.";
    $("betSlipOcrProgress").style.width="0%";
  }finally{betSlipOcrBusy=false;}
}
async function openBetSlipFilePicker(){
  $("betSlipFileInput").click();
}
async function maybeOpenSharedBetSlip(){
  const params=new URLSearchParams(location.search);
  if(params.get("importBetSlip")!=="1"||!("caches" in window))return;
  try{
    const cache=await caches.open(SHARE_CACHE);
    const response=await cache.match(SHARED_BET_SLIP_KEY);
    if(response){
      const blob=await response.blob();
      const type=response.headers.get("Content-Type")||blob.type||"image/png";
      const file=new File([blob],"shared-bet-slip."+((type.split("/")[1]||"png").replace("jpeg","jpg")),{type});
      await cache.delete(SHARED_BET_SLIP_KEY);
      history.replaceState(null,"",location.pathname);
      recognizeBetSlip(file);
    }
  }catch(err){
    console.warn("Shared bet slip could not be opened",err);
  }
}



function cloudConfigured(){
  return Boolean(settings.supabaseUrl && settings.supabaseKey && globalThis.supabase?.createClient);
}
function betModifiedAt(b){
  const candidates=[b?.updatedAt,b?.editedAt,b?.gradedAt,b?.createdAt].map(v=>new Date(v||0).getTime()).filter(Number.isFinite);
  return candidates.length?Math.max(...candidates):0;
}
function cloudRowToBet(row){
  const payload=row?.payload && typeof row.payload==="object" ? {...row.payload} : {};
  return {...payload,id:payload.id||row.bet_id,sport:normalizeSport(payload.sport||"CFB"),market:payload.market||"SPREAD",kind:payload.kind||row.kind||"PREGAME",result:payload.result||row.result||"PENDING",kickoff:payload.kickoff||row.kickoff,away:payload.away||row.away,home:payload.home||row.home,team:payload.team||row.team,line:payload.line??row.line,price:payload.price??row.price,units:payload.units??row.units,stake:payload.stake??row.stake,cloudUpdatedAt:row.updated_at};
}
function betToCloudRow(b){
  return {user_id:cloudUser.id,bet_id:String(b.id),kind:b.kind||"PREGAME",result:b.result||"PENDING",kickoff:b.kickoff||null,away:b.away||null,home:b.home||null,team:b.team||null,line:Number.isFinite(Number(b.line))?Number(b.line):null,price:Number.isFinite(Number(b.price))?Number(b.price):null,units:Number.isFinite(Number(b.units))?Number(b.units):null,stake:Number.isFinite(Number(b.stake))?Number(b.stake):null,payload:{...b,updatedAt:b.updatedAt||new Date().toISOString()},updated_at:new Date().toISOString()};
}
function updateCloudUi(message=null){
  const title=$("cloudLedgerTitle"),status=$("cloudLedgerStatus"),account=$("cloudAccountBtn"),sync=$("cloudSyncBtn"),out=$("cloudSignOutBtn");
  if(!title) return;
  if(!cloudConfigured()){
    title.textContent="☁️ Cloud setup needed";
    status.textContent=message||"Add the Supabase publishable key in Settings, then sign in.";
    account.classList.remove("hidden");sync.classList.add("hidden");out.classList.add("hidden");return;
  }
  if(!cloudUser){
    title.textContent="☁️ Local-only mode";
    status.textContent=message||"Sign in to sync this ledger across your devices.";
    account.classList.remove("hidden");sync.classList.add("hidden");out.classList.add("hidden");return;
  }
  title.textContent=`☁️ Synced account • ${cloudUser.email||"signed in"}`;
  status.textContent=message||(cloudLastSyncAt?`Last sync ${new Date(cloudLastSyncAt).toLocaleTimeString([], {hour:"numeric",minute:"2-digit"})}. Local cache stays available offline.`:"Signed in. Ready to sync your ledger.");
  account.classList.add("hidden");sync.classList.remove("hidden");out.classList.remove("hidden");
}
async function initCloudClient(){
  cloudClient=null;cloudSession=null;cloudUser=null;
  if(!cloudConfigured()){updateCloudUi();return;}
  try{
    cloudClient=globalThis.supabase.createClient(settings.supabaseUrl,settings.supabaseKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    const {data,error}=await cloudClient.auth.getSession(); if(error) throw error;
    cloudSession=data?.session||null;cloudUser=cloudSession?.user||null;updateCloudUi();
    cloudClient.auth.onAuthStateChange(async(event,session)=>{
      cloudSession=session||null;
      cloudUser=session?.user||null;
      if(event==="PASSWORD_RECOVERY"){
        updateCloudUi("Password recovery link verified. Choose a new password.");
        setTimeout(openCloudResetDialog,0);
        return;
      }
      updateCloudUi();
      if(cloudUser) await syncCloudLedger({reason:"auth"});
    });
    if(cloudUser) await syncCloudLedger({reason:"startup"});
  }catch(e){updateCloudUi(`Cloud unavailable: ${e.message||e}`);}
}
function scheduleCloudPush(){
  if(!cloudUser||!cloudClient) return;
  clearTimeout(cloudPushTimer);
  cloudPushTimer=setTimeout(()=>pushAllLocalBetsToCloud().catch(e=>updateCloudUi(`Sync warning: ${e.message||e}`)),500);
}
async function pushAllLocalBetsToCloud(){
  if(!cloudUser||!cloudClient||cloudSyncBusy) return;
  const bets=getBets();
  if(!bets.length){cloudLastSyncAt=new Date().toISOString();updateCloudUi();return;}
  const rows=bets.map(betToCloudRow);
  const {error}=await cloudClient.from(CLOUD_TABLE).upsert(rows,{onConflict:"user_id,bet_id"});
  if(error) throw error;
  cloudLastSyncAt=new Date().toISOString();updateCloudUi(`Synced ${bets.length} wager${bets.length===1?"":"s"} to the private cloud ledger.`);
}
async function syncCloudLedger({reason="manual"}={}){
  if(!cloudUser||!cloudClient||cloudSyncBusy) return;
  cloudSyncBusy=true;updateCloudUi("Syncing phone/laptop ledger…");
  try{
    const {data,error}=await cloudClient.from(CLOUD_TABLE).select("*").eq("user_id",cloudUser.id).order("updated_at",{ascending:false});
    if(error) throw error;
    const local=getBets(), cloud=(data||[]).map(cloudRowToBet), map=new Map();
    for(const b of cloud) map.set(String(b.id),b);
    for(const b of local){
      const k=String(b.id),existing=map.get(k);
      if(!existing || betModifiedAt(b)>=Math.max(betModifiedAt(existing),new Date(existing.cloudUpdatedAt||0).getTime())) map.set(k,b);
    }
    const merged=[...map.values()].sort((a,b)=>new Date(b.createdAt||b.kickoff||0)-new Date(a.createdAt||a.kickoff||0));
    localStorage.setItem("se-bets",JSON.stringify(merged));renderBets();renderLiveBets();renderBetMgmPerformance();
    if(merged.length){
      const {error:upErr}=await cloudClient.from(CLOUD_TABLE).upsert(merged.map(betToCloudRow),{onConflict:"user_id,bet_id"});if(upErr) throw upErr;
    }
    cloudLastSyncAt=new Date().toISOString();updateCloudUi(`Cloud sync complete • ${merged.length} wager${merged.length===1?"":"s"} available on this device.`);
  }catch(e){updateCloudUi(`Sync failed: ${e.message||e}`);}
  finally{cloudSyncBusy=false;}
}
async function deleteCloudBet(id){
  if(!cloudUser||!cloudClient) return;
  const {error}=await cloudClient.from(CLOUD_TABLE).delete().eq("user_id",cloudUser.id).eq("bet_id",String(id));
  if(error) updateCloudUi(`Local delete saved; cloud delete will need retry: ${error.message}`);
}
async function clearCloudLedger(){
  if(!cloudUser||!cloudClient) return;
  const {error}=await cloudClient.from(CLOUD_TABLE).delete().eq("user_id",cloudUser.id);
  if(error) throw error;
}
function openCloudAuth(){
  if(!cloudConfigured()){alert("Cloud sync is not configured on this device yet. Open Settings → Advanced cloud setup once, then sign in.");openSettings();return;}
  $("cloudAuthStatus").textContent="Use Sign in if you already have an account, or Create account the first time.";
  $("cloudPassword").value="";$("cloudAuthDialog").showModal();
}
async function cloudSignIn(email,password){
  if(!cloudClient) await initCloudClient();
  const {data,error}=await cloudClient.auth.signInWithPassword({email,password});if(error)throw error;
  cloudSession=data.session;cloudUser=data.user;updateCloudUi("Signed in. Merging this device with your cloud ledger…");await syncCloudLedger({reason:"signin"});
}
async function cloudSignUp(email,password){
  if(!cloudClient) await initCloudClient();
  const {data,error}=await cloudClient.auth.signUp({email,password});if(error)throw error;
  if(data.session){cloudSession=data.session;cloudUser=data.user;await syncCloudLedger({reason:"signup"});return "Account created and signed in.";}
  return "Account created. Check your email for the Supabase confirmation link, then return and sign in.";
}
async function cloudSendPasswordReset(email){
  if(!email) throw new Error("Enter your account email first.");
  if(!cloudClient) await initCloudClient();
  if(!cloudClient) throw new Error("Cloud connection is not configured on this device.");
  const redirectTo=`${window.location.origin}${window.location.pathname}`;
  const {error}=await cloudClient.auth.resetPasswordForEmail(email,{redirectTo});
  if(error) throw error;
  return "Password reset email sent. Open the link in that email, then choose your new password.";
}
function openCloudResetDialog(){
  $("cloudNewPassword").value="";
  $("cloudConfirmPassword").value="";
  $("cloudResetStatus").textContent="Use at least 8 characters.";
  $("cloudResetDialog").showModal();
}

function makeBetId(){
  if(globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `bet-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
}
function getBets(){
  try{
    const rows=JSON.parse(localStorage.getItem("se-bets")||"[]");
    if(!Array.isArray(rows)) return [];
    let changed=false;
    rows.forEach(b=>{
      if(!b.id){b.id=makeBetId();changed=true;}
      if(!b.kind){b.kind="PREGAME";changed=true;}
      if(!b.result){b.result="PENDING";changed=true;}
      const normalized=normalizeSport(b.sport);
      if(b.sport!==normalized){b.sport=normalized;changed=true;}
      if(!b.market){b.market="SPREAD";changed=true;}
    });
    if(changed)localStorage.setItem("se-bets",JSON.stringify(rows));
    return rows;
  }catch{return [];}
}
function saveBets(bets,{skipCloud=false}={}){
  const now=new Date().toISOString();
  bets.forEach(b=>{if(!b.updatedAt)b.updatedAt=now;});
  localStorage.setItem("se-bets",JSON.stringify(bets));
  renderBets(); renderLiveBets(); renderBetMgmPerformance();
  if(!skipCloud)scheduleCloudPush();
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
  const bets=getBets(), all=betSummary(bets);
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
  $("personalSplits").innerHTML=["CFB","NFL","CBB","NBA","INTL"].map(s=>splitCard(`${sportMeta(s).icon} ${sportMeta(s).short}`,betSummary(bets.filter(b=>normalizeSport(b.sport)===s)))).join("");
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
  $("unitsRisked").textContent=`${bets.reduce((sum,b)=>sum+Number(b.units||0),0).toFixed(1)}u`;
  const visible=currentLedgerSportFilter==="ALL"?bets:bets.filter(b=>normalizeSport(b.sport)===currentLedgerSportFilter);
  if(!bets.length){$("betsTableWrap").innerHTML=`<div class="empty">No sportsbook wagers tracked yet. Add one from the CFB board or use Manual Bet for CFB, NFL, CBB, NBA, or International Basketball.</div>`;return;}
  if(!visible.length){$("betsTableWrap").innerHTML=`<div class="empty">No ${escapeHtml(currentLedgerSportFilter)} wagers are in your ledger yet.</div>`;return;}
  $("betsTableWrap").innerHTML=`<table class="bets-table personal-bets-table"><thead><tr><th>Date</th><th>Sport</th><th>Type</th><th>Game</th><th>Side</th><th>Line</th><th>Odds</th><th>Stake</th><th>Result</th><th>Net</th><th>Edge</th><th>Actions</th></tr></thead><tbody>${visible.map(b=>`<tr>
    <td>${new Date(b.createdAt).toLocaleDateString()}</td><td>${sportBadge(b.sport)}</td><td>${escapeHtml(b.kind||"PREGAME")}${b.manualEntry?`<br><small>MANUAL</small>`:""}</td><td>${escapeHtml(b.away)} @ ${escapeHtml(b.home)}${b.competition?`<br><small>${escapeHtml(b.competition)}</small>`:""}</td><td>${escapeHtml(b.team)}</td><td>${fmtLine(b.line)}</td><td>${fmtPrice(b.price)}</td><td>${Number(b.stake)>0?`$${Number(b.stake).toFixed(2)}`:"—"}</td><td>${resultPill(b)}</td><td>${["WIN","LOSS","PUSH"].includes(b.result)?`${fmtUnits(b.unitsProfit)}${Number.isFinite(Number(b.dollarsProfit))?`<br><small>${Number(b.dollarsProfit)<0?"-":""}$${Math.abs(Number(b.dollarsProfit)).toFixed(2)}</small>`:""}`:"—"}</td><td>${b.edge===null||b.edge===undefined?"—":`${Number(b.edge)>=0?"+":""}${Number(b.edge).toFixed(1)}`}</td><td><div class="bet-row-actions">${String(b.result||"PENDING").toUpperCase()==="PENDING"&&normalizeSport(b.sport)!=="CFB"?`<button class="small-btn settle" onclick="openSettleBet('${escapeHtml(b.id)}')">Settle</button>`:""}<button class="small-btn" onclick="openEditBet('${escapeHtml(b.id)}')">Edit</button><button class="small-btn danger" onclick="deleteBet('${escapeHtml(b.id)}')">Delete</button></div></td>
  </tr>`).join("")}</tbody></table>`;
}
function clearBetGrade(b){
  b.result="PENDING";
  for(const key of ["atsMargin","unitsProfit","dollarsProfit","finalScore","closingLine","clv","gradedAt","gradeSource"]) delete b[key];
}
function americanWinProfit(risk,price){
  const r=Number(risk),p=Number(price);
  if(!Number.isFinite(r)||r<=0||!Number.isFinite(p)||p===0)return 0;
  return p>0 ? r*(p/100) : r*(100/Math.abs(p));
}
function openSettleBet(id){
  const b=getBets().find(x=>String(x.id)===String(id)); if(!b)return;
  $("settleBetId").value=b.id;
  $("settleAwayScore").value="";
  $("settleHomeScore").value="";
  $("settleBetSummary").innerHTML=`${sportBadge(b.sport)} <strong>${escapeHtml(b.away)} @ ${escapeHtml(b.home)}</strong><br>${escapeHtml(b.team)} ${fmtLine(b.line)} • ${fmtPrice(b.price)}${b.competition?` • ${escapeHtml(b.competition)}`:""}`;
  $("settleBetDialog").showModal();
}
window.openSettleBet=openSettleBet;

function gradeSpreadFromFinalScore(b,awayScore,homeScore){
  const away=Number(awayScore),home=Number(homeScore),line=Number(b.line);
  if(!Number.isFinite(away)||!Number.isFinite(home)||!Number.isFinite(line)) throw new Error("Enter valid final scores.");
  let teamMargin=null;
  if(teamNamesMatch(b.team,b.away)) teamMargin=away-home;
  else if(teamNamesMatch(b.team,b.home)) teamMargin=home-away;
  else throw new Error("Bet side does not match the stored away/home team. Edit the wager first.");
  const atsMargin=teamMargin+line;
  const result=Math.abs(atsMargin)<0.0001?"PUSH":atsMargin>0?"WIN":"LOSS";
  const units=Number(b.units)||0,stake=Number(b.stake);
  const unitsProfit=result==="WIN"?americanWinProfit(units,b.price):result==="LOSS"?-units:0;
  const dollarsProfit=Number.isFinite(stake)&&stake>0
    ?(result==="WIN"?americanWinProfit(stake,b.price):result==="LOSS"?-stake:0)
    :null;
  return {result,atsMargin,unitsProfit,dollarsProfit};
}

function deleteBet(id){
  const bets=getBets(), b=bets.find(x=>String(x.id)===String(id));
  if(!b)return;
  if(!confirm(`Delete this wager?

${b.team} ${fmtLine(b.line)}
${b.away} @ ${b.home}`))return;
  saveBets(bets.filter(x=>String(x.id)!==String(id)));
  $("betCheckStatus").textContent="Wager deleted from this device only.";
}
window.deleteBet=deleteBet;
function syncEditBetKind(){
  $("editLiveFields").classList.toggle("hidden",$("editBetKind").value!=="LIVE");
}
function openEditBet(id){
  const b=getBets().find(x=>String(x.id)===String(id)); if(!b)return;
  currentEditingBetId=String(b.id);
  $("editBetId").value=b.id; $("editSport").value=normalizeSport(b.sport); $("editCompetition").value=b.competition||""; $("editBetKind").value=b.kind==="LIVE"?"LIVE":"PREGAME";
  $("editAway").value=b.away||""; $("editHome").value=b.home||""; $("editTeam").value=b.team||"";
  $("editLine").value=Number.isFinite(Number(b.line))?Number(b.line):""; $("editPrice").value=Number.isFinite(Number(b.price))?Number(b.price):-110;
  $("editUnits").value=Number.isFinite(Number(b.units))?Number(b.units):1; $("editStake").value=Number.isFinite(Number(b.stake))&&Number(b.stake)>0?Number(b.stake):"";
  $("editKickoff").value=isoToLocalDateTimeValue(b.kickoff||b.createdAt); $("editScoreAtBet").value=b.scoreAtBet||""; $("editGameState").value=b.gameState||""; $("editNotes").value=b.notes||"";
  const canSettle=String(b.result||"PENDING").toUpperCase()==="PENDING"&&normalizeSport(b.sport)!=="CFB";
  $("editSettleBtn").classList.toggle("hidden",!canSettle);
  syncEditBetKind(); $("editBetDialog").showModal();
}
window.openEditBet=openEditBet;

async function checkBetResults(){
  const btn=$("checkBetResultsBtn"), status=$("betCheckStatus"), bets=getBets();
  if(!bets.length){status.textContent="No tracked bets to check.";return;}
  const cfbBets=bets.filter(b=>normalizeSport(b.sport)==="CFB");
  const futureSportCount=bets.length-cfbBets.length;
  if(!cfbBets.length){
    status.textContent=`Your ${futureSportCount} NFL/CBB/NBA/INTL wager${futureSportCount===1?" is":"s are"} safely tracked. Their automatic graders arrive with those Edge engines.`;
    return;
  }
  btn.disabled=true; status.textContent=`Checking ${cfbBets.length} CFB wager${cfbBets.length===1?"":"s"}…`;
  try{
    const payload=cfbBets.map(b=>({id:b.id,sport:"CFB",market:b.market||"SPREAD",kind:b.kind,gameId:b.gameId,cfbdGameId:b.cfbdGameId,season:b.season,week:b.week,kickoff:b.kickoff,team:b.team,line:b.line,price:b.price,units:b.units,stake:b.stake,away:b.away,home:b.home}));
    const res=await fetch(BET_CHECK_ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({bets:payload})});
    const data=await res.json();
    if(!res.ok)throw new Error(data?.error||`Result check failed (${res.status})`);
    const byId=new Map((data.results||[]).map(r=>[String(r.id),r]));
    let newly=0;
    bets.forEach(b=>{
      if(normalizeSport(b.sport)!=="CFB") return;
      const r=byId.get(String(b.id)); if(!r||r.status!=="GRADED")return;
      if(!["WIN","LOSS","PUSH"].includes(b.result))newly++;
      b.result=r.result; b.atsMargin=r.atsMargin; b.unitsProfit=r.unitsProfit; b.dollarsProfit=r.dollarsProfit; b.finalScore=r.finalScore; b.closingLine=r.closingLine; b.clv=r.clv; b.gradedAt=r.gradedAt; b.gradeSource=r.source;
    });
    saveBets(bets);
    status.textContent=`CFB checker: ${data.checked||cfbBets.length} checked • ${data.graded||0} completed • ${data.pending||0} pending${newly?` • ${newly} newly graded`:""}${futureSportCount?` • ${futureSportCount} NFL/CBB/NBA/INTL tracked separately`:""}.`;
  }catch(e){status.textContent=`⚠ ${e.message||e}`;}
  finally{btn.disabled=false;}
}
function exportBets(){
  const blob=new Blob([JSON.stringify({version:"Saturday Edge Multi-Sport Ledger v0.1",exportedAt:new Date().toISOString(),bets:getBets()},null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`saturday-edge-multisport-ledger-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function importBetsFile(file){
  const reader=new FileReader();reader.onload=()=>{try{const parsed=JSON.parse(reader.result);const incoming=Array.isArray(parsed)?parsed:parsed?.bets;if(!Array.isArray(incoming))throw new Error("No bets array found.");const current=getBets();const seen=new Set(current.map(b=>b.id));for(const row of incoming){
      if(!row.id)row.id=makeBetId();
      row.sport=normalizeSport(row.sport);
      if(!row.market)row.market="SPREAD";
      if(!seen.has(row.id)){current.push(row);seen.add(row.id);}
    }current.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));saveBets(current);$("betCheckStatus").textContent=`Imported ${incoming.length} ledger rows. Duplicate IDs were skipped.`;}catch(e){alert(`Could not import ledger: ${e.message||e}`);}};reader.readAsText(file);
}
function openBetMgm(){window.open(BETMGM_URL,"_blank","noopener,noreferrer");} window.openBetMgm=openBetMgm;

$("betSlipImportForm").addEventListener("submit",e=>{
  e.preventDefault();
  const rawSport=$("importSport").value;
  if(!EDGE_SPORTS[rawSport]){
    $("betSlipConfidence").textContent="Choose the correct sport before saving this wager.";
    return;
  }
  const sport=rawSport;
  const kind=$("importBetKind").value==="LIVE"?"LIVE":"PREGAME";
  const away=$("importAway").value.trim(),home=$("importHome").value.trim(),team=$("importTeam").value.trim();
  const line=Number($("importLine").value),price=Number($("importPrice").value),units=Number($("importUnits").value);
  const stake=$("importStake").value===""?null:Number($("importStake").value);
  const kickoffDate=new Date($("importKickoff").value);
  if(!away||!home||!team||!Number.isFinite(line)||!Number.isFinite(price)||!Number.isFinite(units)||Number.isNaN(kickoffDate.getTime())){
    $("betSlipConfidence").textContent="Fill the matchup, bet side, line, odds, units, and game date/time before saving.";
    return;
  }
  const kickoff=kickoffDate.toISOString(),sportsbook=$("importSportsbook").value.trim(),competition=$("importCompetition").value.trim();
  const bets=getBets();
  bets.unshift({
    id:makeBetId(),sport,market:"SPREAD",kind,result:"PENDING",manualEntry:true,
    importSource:"BET_SLIP_OCR",sportsbook:sportsbook||null,competition:competition||null,createdAt:new Date().toISOString(),
    gameId:manualGameId(away,home,kickoff,sport),cfbdGameId:null,season:kickoffDate.getFullYear(),week:null,kickoff,
    away,home,team,line,price,units,stake,
    edge:null,projectedLine:null,classification:"IMPORTED",
    gameState:kind==="LIVE"?"LIVE • imported from bet slip":null,
    scoreAtBet:null,
    notes:$("importNotes").value.trim()
  });
  saveBets(bets);
  $("betCheckStatus").textContent=sport==="CFB"
    ?`📸 Imported ${sportsbook||"sportsbook"} CFB wager. Check Results can grade it after the game is final.`
    :`📸 Imported ${sportsbook||"sportsbook"} ${sport} wager and synced it to your cloud ledger.`;
  $("betSlipImportDialog").close();
  clearBetSlipPreviewUrl();
  currentBetSlipFile=null;
});

$("manualBetForm").addEventListener("submit",e=>{
  e.preventDefault();
  const sport=normalizeSport($("manualSport").value);
  const competition=$("manualCompetition").value.trim();
  const kind=$("manualBetKind").value==="LIVE"?"LIVE":"PREGAME";
  const away=$("manualAway").value.trim(), home=$("manualHome").value.trim(), team=$("manualTeam").value.trim();
  const line=Number($("manualLine").value), price=Number($("manualPrice").value), units=Number($("manualUnits").value);
  const stake=$("manualStake").value===""?null:Number($("manualStake").value);
  const kickoffLocal=$("manualKickoff").value;
  if(!away||!home||!team||!Number.isFinite(line)||!Number.isFinite(price)||!Number.isFinite(units)||!kickoffLocal){
    alert("Please enter the game, side, line, price, units, and game date/time."); return;
  }
  const kickoffDate=new Date(kickoffLocal);
  if(Number.isNaN(kickoffDate.getTime())){alert("Please enter a valid game date/time.");return;}
  const kickoff=kickoffDate.toISOString();
  const season=kickoffDate.getFullYear();
  const bets=getBets();
  bets.unshift({
    id:makeBetId(),sport,competition:competition||null,market:"SPREAD",kind,result:"PENDING",manualEntry:true,createdAt:new Date().toISOString(),
    gameId:manualGameId(away,home,kickoff,sport),cfbdGameId:null,season,week:null,kickoff,
    away,home,team,line,price,units,stake,
    edge:null,projectedLine:null,classification:"MANUAL",
    gameState:kind==="LIVE"?($("manualGameState").value.trim()||"LIVE • manually entered"):null,
    scoreAtBet:kind==="LIVE"?($("manualScoreAtBet").value.trim()||null):null,
    notes:$("manualNotes").value.trim()
  });
  saveBets(bets);
  $("betCheckStatus").textContent=sport==="CFB"?`Manual CFB ${kind.toLowerCase()} wager added. Check Results can grade it after the game is final.`:`${sport} wager added and synced. Automatic ${sport} grading will arrive with the ${sport} Edge engine.`;
  $("manualBetDialog").close();
});


$("editSettleBtn").addEventListener("click",()=>{
  const id=$("editBetId").value||currentEditingBetId;
  if(!id)return;
  $("editBetDialog").close();
  openSettleBet(id);
});
$("settleBetClose").addEventListener("click",()=>$("settleBetDialog").close());
$("settleBetForm").addEventListener("submit",e=>{
  e.preventDefault();
  const id=$("settleBetId").value,bets=getBets(),idx=bets.findIndex(b=>String(b.id)===String(id));
  if(idx<0){alert("That wager could not be found.");return;}
  const b=bets[idx],awayScore=Number($("settleAwayScore").value),homeScore=Number($("settleHomeScore").value);
  try{
    const grade=gradeSpreadFromFinalScore(b,awayScore,homeScore);
    b.result=grade.result;
    b.atsMargin=grade.atsMargin;
    b.unitsProfit=grade.unitsProfit;
    if(grade.dollarsProfit===null) delete b.dollarsProfit; else b.dollarsProfit=grade.dollarsProfit;
    b.finalScore=`${b.away} ${awayScore} - ${b.home} ${homeScore}`;
    b.gradedAt=new Date().toISOString();
    b.gradeSource="MANUAL_FINAL_SCORE";
    b.updatedAt=b.gradedAt;
    bets[idx]=b;
    saveBets(bets);
    $("betCheckStatus").textContent=`${sportMeta(b.sport).short} wager settled from the final score: ${grade.result}.`;
    $("settleBetDialog").close();
  }catch(err){alert(err.message||String(err));}
});

$("editBetForm").addEventListener("submit",e=>{
  e.preventDefault();
  const id=$("editBetId").value||currentEditingBetId, bets=getBets(), idx=bets.findIndex(b=>String(b.id)===String(id));
  if(idx<0){alert("That wager could not be found.");return;}
  const b=bets[idx], old={sport:normalizeSport(b.sport),kind:b.kind,away:b.away,home:b.home,team:b.team,line:Number(b.line),price:Number(b.price),units:Number(b.units),stake:b.stake===null||b.stake===undefined?null:Number(b.stake),kickoff:b.kickoff};
  const sport=normalizeSport($("editSport").value), competition=$("editCompetition").value.trim(), kind=$("editBetKind").value==="LIVE"?"LIVE":"PREGAME", away=$("editAway").value.trim(), home=$("editHome").value.trim(), team=$("editTeam").value.trim();
  const line=Number($("editLine").value), price=Number($("editPrice").value), units=Number($("editUnits").value), stake=$("editStake").value===""?null:Number($("editStake").value);
  const kickoffDate=new Date($("editKickoff").value);
  if(!away||!home||!team||!Number.isFinite(line)||!Number.isFinite(price)||!Number.isFinite(units)||Number.isNaN(kickoffDate.getTime())){alert("Please enter a valid game, side, line, price, units, and kickoff time.");return;}
  const kickoff=kickoffDate.toISOString();
  const criticalChanged=old.sport!==sport||old.kind!==kind||old.away!==away||old.home!==home||old.team!==team||old.line!==line||old.price!==price||old.units!==units||old.stake!==stake||!sameKickoffMinute(old.kickoff,kickoff);
  const identityChanged=old.sport!==sport||old.away!==away||old.home!==home||!sameKickoffMinute(old.kickoff,kickoff);
  Object.assign(b,{sport,competition:competition||null,market:b.market||"SPREAD",kind,away,home,team,line,price,units,stake,kickoff,season:kickoffDate.getFullYear(),notes:$("editNotes").value.trim(),gameState:kind==="LIVE"?($("editGameState").value.trim()||b.gameState||"LIVE • edited"):null,scoreAtBet:kind==="LIVE"?($("editScoreAtBet").value.trim()||null):null,editedAt:new Date().toISOString()});
  if(identityChanged){b.gameId=manualGameId(away,home,kickoff,sport);b.cfbdGameId=null;b.week=null;b.manualEntry=true;}
  if(identityChanged||old.team!==team){b.edge=null;b.edgeScore=null;b.projectedLine=null;b.classification="EDITED";b.consensusLine=null;b.betmgmVsConsensus=null;b.matchedSystems=[];}
  if(criticalChanged)clearBetGrade(b);
  bets[idx]=b; saveBets(bets);
  $("betCheckStatus").textContent=criticalChanged
    ?(sport==="CFB"?"Wager updated and reset to Pending. Tap Check Results to grade the corrected ticket.":"Wager updated and reset to Pending. Use Settle after the game is final.")
    :"Wager notes/context updated. Existing grade preserved.";
  currentEditingBetId=null; $("editBetDialog").close();
});

$("betForm").addEventListener("submit",e=>{
  e.preventDefault(); if(!currentBetGame) return;
  const g=currentBetGame,bets=getBets();
  const team=$("betTeam").value, stake=$("betStake").value===""?null:Number($("betStake").value);
  if(currentBetKind==="LIVE"){
    const lm=g.liveModel||{};
    const isRec=teamNamesMatch(team,lm.recommendedTeam);
    const edge=lm.edge===null||lm.edge===undefined?null:(isRec?Number(lm.edge):-Number(lm.edge));
    const fair=lm.fairLineForRecommendedTeam===null||lm.fairLineForRecommendedTeam===undefined?null:(isRec?Number(lm.fairLineForRecommendedTeam):-Number(lm.fairLineForRecommendedTeam));
    bets.unshift({id:makeBetId(),sport:"CFB",market:"SPREAD",kind:"LIVE",result:"PENDING",createdAt:new Date().toISOString(),gameId:g.gameId,cfbdGameId:g.cfbdGameId,season:g.season??null,week:g.week??null,kickoff:g.kickoff,away:g.away,home:g.home,team,line:Number($("betLine").value),price:Number($("betPrice").value),units:Number($("betUnits").value),stake,edge,projectedLine:fair,classification:lm.signal||"TRACK_ONLY",gameState:liveGameState(g),scoreAtBet:`${g.awayScore??"—"}-${g.homeScore??"—"}`,possession:g.possession??null,pregameClose:lm.pregameCloseForRecommendedTeam??null,notes:$("betNotes").value.trim()});
  }else{
    bets.unshift({id:makeBetId(),sport:"CFB",market:"SPREAD",kind:"PREGAME",result:"PENDING",createdAt:new Date().toISOString(),gameId:g.id,cfbdGameId:g.cfbdGameId??null,season:g.season??null,week:g.week??null,kickoff:g.kickoff,away:g.away,home:g.home,team,line:Number($("betLine").value),price:Number($("betPrice").value),units:Number($("betUnits").value),stake,edge:Number(g.edge),edgeScore:Number(g.edgeScore),projectedLine:Number(g.projectedLine),classification:g.classification,consensusLine:g.marketConsensus?.consensusLine??null,betmgmVsConsensus:g.marketConsensus?.betmgmVsConsensus??null,matchedSystems:g.matchedSystems||[],notes:$("betNotes").value.trim()});
  }
  saveBets(bets); $("betDialog").close();
});

function openSettings(){
  $("modeSelect").value=settings.mode;
  $("endpointInput").value=settings.endpoint||"";
  $("liveEndpointInput").value=settings.liveEndpoint||LIVE_EDGE_ENDPOINT;
  $("supabaseUrlInput").value=settings.supabaseUrl||DEFAULT_SUPABASE_URL;
  $("supabaseKeyInput").value=settings.supabaseKey||"";
  $("cloudSettingsStatus").textContent=settings.supabaseKey
    ?"☁️ Cloud sync is configured. Account connection is managed automatically on this device."
    :"☁️ Cloud sync needs one-time setup on this device. Open Advanced cloud setup below.";
  $("settingsDialog").showModal();
}
$("saveSettingsBtn").addEventListener("click",async()=>{
  const advancedUrl=$("supabaseUrlInput").value.trim();
  const advancedKey=$("supabaseKeyInput").value.trim();
  settings={
    ...settings,
    version:SETTINGS_VERSION,
    mode:$("modeSelect").value,
    endpoint:$("endpointInput").value.trim(),
    liveEndpoint:$("liveEndpointInput").value.trim()||LIVE_EDGE_ENDPOINT,
    supabaseUrl:advancedUrl||settings.supabaseUrl||DEFAULT_SUPABASE_URL,
    supabaseKey:advancedKey||settings.supabaseKey||""
  };
  localStorage.setItem("se-settings",JSON.stringify(settings));
  $("settingsDialog").close();
  await initCloudClient();
  setTimeout(()=>{maybeOpenSharedBetSlip();maybeOpenSharedHistory();},350);
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
$("manualBetClose").addEventListener("click",()=>$("manualBetDialog").close());
$("editBetClose").addEventListener("click",()=>$("editBetDialog").close());
$("editBetKind").addEventListener("change",syncEditBetKind);
$("importBetMgmHistoryBtn").addEventListener("click",openBetMgmHistoryImport);
$("betMgmHistoryClose").addEventListener("click",()=>$("betMgmHistoryDialog").close());
$("chooseHistoryImagesBtn").addEventListener("click",()=>$("historyImagesInput").click());
$("historyImagesInput").addEventListener("change",e=>{const files=[...(e.target.files||[])];if(files.length)scanHistoryImages(files);e.target.value="";});
$("scanHistoryTextBtn").addEventListener("click",()=>scanPastedHistoryText($("historyPasteText").value));
$("historySetUnknownCfbBtn").addEventListener("click",()=>{
  historyImportCandidates=historyImportCandidates.map(c=>c.sport?c:{...c,sport:"CFB",complete:Boolean(c.away&&c.home&&c.team&&Number.isFinite(c.line)&&Number.isFinite(c.price))});
  historyImportCandidates=findHistoryDuplicates(historyImportCandidates);
  renderHistoryReview();
});
$("historySetUnknownCbbBtn").addEventListener("click",()=>{
  historyImportCandidates=historyImportCandidates.map(c=>c.sport?c:{...c,sport:"CBB",complete:Boolean(c.away&&c.home&&c.team&&Number.isFinite(c.line)&&Number.isFinite(c.price))});
  historyImportCandidates=findHistoryDuplicates(historyImportCandidates);
  renderHistoryReview();
});
$("historySelectAllBtn").addEventListener("click",()=>{
  $("historyReviewList").querySelectorAll(".history-pick:not(:disabled)").forEach(x=>x.checked=true);
});
$("historyClearReviewBtn").addEventListener("click",()=>{
  historyImportCandidates=[];$("historyPasteText").value="";$("historyRawText").value="";renderHistoryReview();
});
$("importSelectedHistoryBtn").addEventListener("click",importReviewedHistory);
$("historyReviewList").addEventListener("change",e=>{
  const card=e.target.closest?.(".history-review-card");
  if(!card){refreshHistoryImportButton();return;}
  const pick=card.querySelector(".history-pick");
  if(e.target!==pick && pick && !pick.disabled){
    const sport=card.querySelector(".hr-sport")?.value;
    const away=card.querySelector(".hr-away")?.value.trim();
    const home=card.querySelector(".hr-home")?.value.trim();
    const team=card.querySelector(".hr-team")?.value.trim();
    const line=Number(card.querySelector(".hr-line")?.value);
    const price=Number(card.querySelector(".hr-price")?.value);
    if(EDGE_SPORTS[sport]&&away&&home&&team&&Number.isFinite(line)&&Number.isFinite(price))pick.checked=true;
  }
  refreshHistoryImportButton();
});
$("historyReviewList").addEventListener("input",refreshHistoryImportButton);
$("importBetSlipBtn").addEventListener("click",openBetSlipFilePicker);
$("betSlipFileInput").addEventListener("change",e=>{const file=e.target.files?.[0];if(file)recognizeBetSlip(file);e.target.value="";});
$("betSlipImportClose").addEventListener("click",()=>{$("betSlipImportDialog").close();clearBetSlipPreviewUrl();});
$("manualBetBtn").addEventListener("click",openManualBet);
$("manualBetKind").addEventListener("change",syncManualBetKind);
$("manualSport").addEventListener("change",updateManualSportHint);
$("ledgerSportFilter").addEventListener("click",e=>{
  const btn=e.target.closest("[data-ledger-sport]");
  if(!btn)return;
  currentLedgerSportFilter=btn.dataset.ledgerSport||"ALL";
  $("ledgerSportFilter").querySelectorAll("[data-ledger-sport]").forEach(x=>x.classList.toggle("active",x===btn));
  renderBets();
});
$("cloudAccountBtn").addEventListener("click",openCloudAuth);
$("cloudSyncBtn").addEventListener("click",()=>syncCloudLedger({reason:"manual"}));
$("cloudSignOutBtn").addEventListener("click",async()=>{if(cloudClient)await cloudClient.auth.signOut();cloudSession=null;cloudUser=null;updateCloudUi("Signed out. This device still keeps its local cache.");});
$("cloudAuthClose").addEventListener("click",()=>$("cloudAuthDialog").close());
$("cloudResetClose").addEventListener("click",()=>$("cloudResetDialog").close());
$("cloudAuthForm").addEventListener("submit",async e=>{e.preventDefault();const email=$("cloudEmail").value.trim(),password=$("cloudPassword").value;$("cloudAuthStatus").textContent="Signing in…";try{await cloudSignIn(email,password);$("cloudAuthDialog").close();}catch(err){$("cloudAuthStatus").textContent=`Sign in failed: ${err.message||err}`;}});
$("cloudSignUpBtn").addEventListener("click",async()=>{const email=$("cloudEmail").value.trim(),password=$("cloudPassword").value;if(!email||!password){$("cloudAuthStatus").textContent="Enter an email and password first.";return;}$("cloudAuthStatus").textContent="Creating account…";try{$("cloudAuthStatus").textContent=await cloudSignUp(email,password);}catch(err){$("cloudAuthStatus").textContent=`Account creation failed: ${err.message||err}`;}});
$("cloudForgotBtn").addEventListener("click",async()=>{
  const email=$("cloudEmail").value.trim();
  $("cloudAuthStatus").textContent="Sending password reset email…";
  try{$("cloudAuthStatus").textContent=await cloudSendPasswordReset(email);}
  catch(err){$("cloudAuthStatus").textContent=`Password reset failed: ${err.message||err}`;}
});
$("cloudResetForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const p1=$("cloudNewPassword").value,p2=$("cloudConfirmPassword").value;
  if(p1.length<8){$("cloudResetStatus").textContent="Password must be at least 8 characters.";return;}
  if(p1!==p2){$("cloudResetStatus").textContent="Passwords do not match.";return;}
  $("cloudResetStatus").textContent="Updating password…";
  try{
    if(!cloudClient) await initCloudClient();
    const {error}=await cloudClient.auth.updateUser({password:p1});
    if(error) throw error;
    $("cloudResetStatus").textContent="Password updated successfully.";
    setTimeout(()=>{$("cloudResetDialog").close();updateCloudUi("Password updated. Your cloud ledger remains connected.");history.replaceState(null,"",window.location.pathname);},700);
  }catch(err){$("cloudResetStatus").textContent=`Password update failed: ${err.message||err}`;}
});
$("openBetMgmBtn").addEventListener("click",openBetMgm);
$("checkBetResultsBtn").addEventListener("click",checkBetResults);
$("exportBetsBtn").addEventListener("click",exportBets);
$("importBetsBtn").addEventListener("click",()=>$("importBetsFile").click());
$("importBetsFile").addEventListener("change",e=>{const file=e.target.files?.[0];if(file)importBetsFile(file);e.target.value="";});
$("clearBetsBtn").addEventListener("click",async()=>{if(confirm(cloudUser?"Clear every wager from this device AND your synced cloud ledger?":"Clear every wager from the local ledger on this device?")){saveBets([],{skipCloud:true});if(cloudUser){try{await clearCloudLedger();updateCloudUi("Cloud ledger cleared.");}catch(e){updateCloudUi(`Local ledger cleared, but cloud clear failed: ${e.message||e}`);}}}});

function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}

if("serviceWorker" in navigator){window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js?v=94e").catch(()=>{}));}
(async()=>{
  renderLiveBets();
  renderBetMgmPerformance();
  updateCloudUi();
  await initCloudClient();
  setTimeout(()=>{maybeOpenSharedBetSlip();maybeOpenSharedHistory();},350);
  await loadGames();
  await loadPerformance();
})();
