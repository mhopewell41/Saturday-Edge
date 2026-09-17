const LIVE_ENDPOINT = "https://ahskdtpxsjqasbpbvxja.supabase.co/functions/v1/saturday-edge-board";
const PERFORMANCE_ENDPOINT = "https://ahskdtpxsjqasbpbvxja.supabase.co/functions/v1/saturday-edge-performance";
const SETTINGS_VERSION = 8;

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
let currentTimeFilter = "ALL";
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

const LIVE_CACHE_KEY="se-live-board-cache-v064";
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
    $("refreshBtn").disabled=false;
    renderCoverage();
    render();
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
    matchesTimeFilter(g)
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
        <div class="market-row">${locked?`<span class="market-chip caution">🔒 PREGAME CARD LOCKED</span>`:""} ${marketChip(g)} <span class="consensus-text">Consensus ${consensus}${g.marketConsensus?.bookCount?` (${g.marketConsensus.bookCount} books)`:""}</span>${movementChip(g)}</div>
      </div>
      <div class="metric"><label>Best side</label><strong>${escapeHtml(g.recommendedTeam)}</strong></div>
      <div class="metric"><label>BetMGM</label><strong>${fmtLine(g.marketLine)}</strong></div>
      <div class="metric"><label>Our line</label><strong>${fmtLine(g.projectedLine)}</strong></div>
      <div class="metric"><label>Edge</label><strong class="edge-positive">+${Math.abs(Number(g.edge||0)).toFixed(1)}</strong></div>
      <div class="rating"><span class="badge ${escapeHtml(g.classification)}">${badgeText(g.classification)} ${Math.round(Number(g.edgeScore||0))}</span></div>
      <div class="card-actions"><button class="small-btn" onclick="openWhy('${g.id}')">WHY?</button>${locked?`<button class="small-btn locked" disabled>🔒 Locked</button>`:`<button class="small-btn bet" onclick="openBet('${g.id}')">+ Track</button>`}</div>
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
    <div class="why-stat"><span>Rating systems</span><strong>${escapeHtml(systems)}</strong></div>${movementStats}
  </div>
  <div class="reason-list">${(g.factors||[]).map(f=>`<div class="reason ${f.type||"info"}">${escapeHtml(f.text)}</div>`).join("")}</div>`;
  $("gameDialog").showModal();
}
window.openWhy=openWhy;

function openBet(id){
  const g=games.find(x=>x.id===id); if(!g) return;
  if(isPregameLocked(g)){
    alert("This game has started or is inside the 5-minute pregame safety buffer. Saturday Edge will not track a new wager from this card.");
    return;
  }
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
$("tabs").addEventListener("click",e=>{
  const btn=e.target.closest(".tab");
  if(!btn)return;
  $("tabs").querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
  btn.classList.add("active");
  currentFilter=btn.dataset.filter;
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
  await loadGames();
  await loadPerformance();
});
$("settingsBtn").addEventListener("click",openSettings);
$("dialogClose").addEventListener("click",()=>$("gameDialog").close());
$("settingsClose").addEventListener("click",()=>$("settingsDialog").close());
$("betDialogClose").addEventListener("click",()=>$("betDialog").close());
$("clearBetsBtn").addEventListener("click",()=>{if(confirm("Clear every wager from the local bet ledger?"))saveBets([]);});

function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}

if("serviceWorker" in navigator){window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js?v=63").catch(()=>{}));}
(async()=>{
  await loadGames();
  await loadPerformance();
})();
