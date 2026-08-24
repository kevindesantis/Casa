const modes = ['Casa', 'Fuori', 'Notte', 'Ospiti', 'Vacanza'];
let modeIndex = 0;
let presence = false;
let blackoutRunning = false;

const devices = [
  { id:'aqara_tettoia', room:'Tettoia', name:'Presenza Tettoia', type:'presence_sensor', provider:'Aqara', online:true, actual:false, desired:null },
  { id:'sonoff_ventole', room:'Tettoia', name:'Ventole', type:'switch', provider:'Sonoff', online:true, actual:false, desired:false },
  { id:'ezviz_tettoia', room:'Tettoia', name:'Luce Tettoia', type:'light', provider:'EZVIZ', online:true, actual:false, desired:false, manualOverrideUntil:0 },
  { id:'tapo_cucina', room:'Cucina', name:'Luce Cucina', type:'light', provider:'Tapo', online:true, actual:false, desired:false, manualOverrideUntil:0 },
  { id:'lepro_strip', room:'Cucina', name:'Striscia LED', type:'light', provider:'Lepro', online:true, actual:false, desired:false, manualOverrideUntil:0 },
  { id:'roborock', room:'Casa', name:'Roborock', type:'vacuum', provider:'Roborock', online:true, actual:'dock', desired:'dock' },
  { id:'firetv', room:'Soggiorno', name:'Fire TV', type:'media_player', provider:'Amazon', online:true, actual:'standby', desired:null },
  { id:'chromecast', room:'Soggiorno', name:'Chromecast', type:'media_player', provider:'Google', online:true, actual:'idle', desired:null },
];

const rules = [
  { title:'Luci durante il giorno', desc:'Se è giorno e non c’è override manuale, stato desiderato = OFF.' },
  { title:'Ripristino dopo blackout', desc:'Quando una luce torna online, rivaluta immediatamente lo stato desiderato.' },
  { title:'Ventole su presenza', desc:'Presenza Aqara per 5 s (demo) → Sonoff ON; assenza → OFF.' },
  { title:'Override manuale', desc:'Un comando manuale sospende le regole sulla luce per 30 minuti.' },
];

const events = [];

function nowTime(){ return new Date().toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function isDay(){ const h = new Date().getHours(); return h >= 7 && h < 19; }
function log(title, detail=''){
  events.unshift({time:nowTime(), title, detail});
  if(events.length>120) events.pop();
  renderEvents();
}
function setDevice(id, patch, source='Sistema'){
  const d = devices.find(x=>x.id===id); if(!d) return;
  Object.assign(d, patch);
  document.getElementById('lastSync').textContent = 'Aggiornato ' + nowTime();
  renderDevices(); renderStats();
  log(`${d.name}: ${formatActual(d)}`, `${source} · ${d.provider}`);
}
function formatActual(d){
  if(!d.online) return 'OFFLINE';
  if(typeof d.actual==='boolean') return d.actual ? 'ON' : 'OFF';
  return String(d.actual).toUpperCase();
}
function desiredLabel(d){
  if(d.desired===null || d.desired===undefined) return '—';
  if(typeof d.desired==='boolean') return d.desired ? 'ON' : 'OFF';
  return String(d.desired).toUpperCase();
}
function isOverride(d){ return d.manualOverrideUntil && Date.now() < d.manualOverrideUntil; }

function computeDesiredStates(){
  const day = isDay();
  const mode = modes[modeIndex];
  for(const d of devices){
    if(d.type==='light'){
      if(isOverride(d)) continue;
      if(day || mode==='Fuori' || mode==='Vacanza') d.desired = false;
    }
    if(d.id==='sonoff_ventole') d.desired = presence;
  }
}

function reconcile(reason='Riconciliazione'){
  computeDesiredStates();
  for(const d of devices){
    if(!d.online || d.desired===null || d.desired===undefined) continue;
    if(d.actual !== d.desired){
      if(isOverride(d)) { log(`${d.name}: override attivo`, 'Regola sospesa'); continue; }
      const target = d.desired;
      log(`${d.name}: disallineamento`, `Reale ${formatActual(d)} · Desiderato ${desiredLabel(d)} · ${reason}`);
      setTimeout(()=>{
        d.actual = target;
        renderDevices(); renderStats();
        log(`${d.name}: corretto → ${desiredLabel(d)}`, 'Comando confermato');
      }, 650);
    }
  }
  renderDevices(); renderStats();
}

function manualToggle(id){
  const d = devices.find(x=>x.id===id); if(!d || typeof d.actual!=='boolean' || !d.online) return;
  d.actual = !d.actual;
  d.manualOverrideUntil = Date.now() + 30*60*1000;
  d.desired = d.actual;
  renderDevices(); renderStats();
  log(`${d.name}: comando manuale → ${d.actual?'ON':'OFF'}`, 'Override attivo per 30 minuti');
}

function renderStats(){
  const online = devices.filter(d=>d.online).length;
  const on = devices.filter(d=>d.online && d.actual===true).length;
  const mismatch = devices.filter(d=>d.online && d.desired!==null && d.desired!==undefined && d.actual!==d.desired && !isOverride(d)).length;
  document.getElementById('stats').innerHTML = `
    <div class="stat"><span class="muted">Online</span><strong>${online}/${devices.length}</strong></div>
    <div class="stat"><span class="muted">Accesi</span><strong>${on}</strong></div>
    <div class="stat"><span class="muted">Da correggere</span><strong>${mismatch}</strong></div>`;
}

function renderDevices(){
  const groups = [...new Set(devices.map(d=>d.room))];
  document.getElementById('rooms').innerHTML = groups.map(room=>{
    const rows = devices.filter(d=>d.room===room).map(d=>{
      const cls = !d.online ? 'offline' : d.actual===true ? 'on' : 'off';
      const canToggle = ['light','switch'].includes(d.type);
      const override = isOverride(d) ? ' · override manuale' : '';
      return `<div class="device">
        <div><div class="device-name">${d.name}</div><div class="device-meta">${d.provider} · ${d.type}${override}</div></div>
        <div class="device-state"><span class="badge ${cls}">${formatActual(d)}</span><span class="desired">desiderato: ${desiredLabel(d)}</span>${canToggle?`<button class="secondary toggle" data-toggle="${d.id}" ${!d.online?'disabled':''}>Cambia</button>`:''}</div>
      </div>`;
    }).join('');
    return `<article class="room-card"><div class="room-title">${room}</div>${rows}</article>`;
  }).join('');
  document.querySelectorAll('[data-toggle]').forEach(btn=>btn.addEventListener('click',()=>manualToggle(btn.dataset.toggle)));
}

function renderRules(){
  document.getElementById('rules').innerHTML = rules.map((r,i)=>`<article class="rule"><div class="rule-index">${i+1}</div><div><div class="rule-title">${r.title}</div><div class="rule-desc">${r.desc}</div></div><div class="rule-status">ATTIVA</div></article>`).join('');
}
function renderEvents(){
  document.getElementById('events').innerHTML = events.length ? events.map(e=>`<div class="event"><time>${e.time}</time><div><strong>${e.title}</strong><span class="muted">${e.detail}</span></div></div>`).join('') : '<div class="event"><time>—</time><div><strong>Nessun evento</strong><span class="muted">Usa i pulsanti di test.</span></div></div>';
}

async function simulateBlackout(){
  if(blackoutRunning) return;
  blackoutRunning = true;
  log('BLACKOUT simulato', 'Tutti i dispositivi alimentati diventano offline');
  for(const d of devices){ if(!['aqara_tettoia'].includes(d.id)) d.online=false; }
  renderDevices(); renderStats();
  await new Promise(r=>setTimeout(r,1200));
  log('Corrente ripristinata', 'Le lampadine simulano power-on = ON');
  for(const d of devices){
    d.online=true;
    if(d.type==='light') { d.actual=true; d.manualOverrideUntil=0; }
  }
  renderDevices(); renderStats();
  await new Promise(r=>setTimeout(r,700));
  reconcile('Ritorno online dopo blackout');
  blackoutRunning = false;
}

function togglePresence(){
  presence = !presence;
  const d = devices.find(x=>x.id==='aqara_tettoia');
  d.actual = presence;
  renderDevices(); renderStats();
  log(`Aqara Tettoia → ${presence?'PRESENZA':'ASSENZA'}`, 'Evento realtime simulato');
  if(presence){
    log('Trigger ventole avviato', 'Presenza deve restare attiva 5 secondi (demo)');
    setTimeout(()=>{
      if(presence){ log('Trigger ventole confermato', 'Presenza ancora attiva'); reconcile('Trigger presenza'); }
      else log('Trigger ventole annullato', 'Presenza terminata prima della soglia');
    },5000);
  } else reconcile('Fine presenza');
}

document.getElementById('cycleMode').addEventListener('click',()=>{
  modeIndex=(modeIndex+1)%modes.length;
  document.getElementById('modeLabel').textContent=modes[modeIndex];
  log(`Modalità casa → ${modes[modeIndex]}`,'Cambio manuale');
  reconcile('Cambio modalità');
});
document.getElementById('presenceBtn').addEventListener('click',togglePresence);
document.getElementById('blackoutBtn').addEventListener('click',simulateBlackout);
document.getElementById('reconcileBtn').addEventListener('click',()=>reconcile('Controllo manuale'));
document.getElementById('clearLog').addEventListener('click',()=>{events.length=0;renderEvents();});

if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
renderDevices(); renderRules(); renderStats(); renderEvents();
log('Casa Live avviata','V1 demo locale');
reconcile('Avvio applicazione');
