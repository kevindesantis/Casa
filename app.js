const MODE_LABELS = {
  home: 'Casa',
  away: 'Fuori',
  night: 'Notte',
  guests: 'Ospiti',
  vacation: 'Vacanza'
};
const MODE_ORDER = Object.keys(MODE_LABELS);
const DEMO_DEVICES = [
  { external_id:'aqara_tettoia', room:'Tettoia', name:'Presenza Tettoia', device_type:'presence_sensor', provider:'aqara', capabilities:{presence:true} },
  { external_id:'sonoff_ventole', room:'Tettoia', name:'Ventole', device_type:'switch', provider:'ewelink', capabilities:{on_off:true} },
  { external_id:'ezviz_tettoia', room:'Tettoia', name:'Luce Tettoia', device_type:'light', provider:'ezviz', capabilities:{on_off:true,brightness:true} },
  { external_id:'tapo_cucina', room:'Cucina', name:'Luce Cucina', device_type:'light', provider:'tapo', capabilities:{on_off:true,brightness:true} },
  { external_id:'lepro_strip', room:'Cucina', name:'Striscia LED', device_type:'light', provider:'lepro', capabilities:{on_off:true,brightness:true,color:true} },
  { external_id:'roborock', room:'Casa', name:'Roborock', device_type:'vacuum', provider:'roborock', capabilities:{start:true,dock:true} },
  { external_id:'firetv', room:'Soggiorno', name:'Fire TV', device_type:'media_player', provider:'amazon', capabilities:{} },
  { external_id:'chromecast', room:'Soggiorno', name:'Chromecast', device_type:'media_player', provider:'google', capabilities:{} }
];
const RULES = [
  { title:'Luci durante il giorno', desc:'Se è giorno e non c’è override manuale, stato desiderato = OFF.' },
  { title:'Ripristino dopo blackout', desc:'Quando una luce torna online, rivaluta immediatamente lo stato desiderato.' },
  { title:'Ventole su presenza', desc:'Presenza Aqara per 5 s (demo) → Sonoff ON; assenza → OFF.' },
  { title:'Override manuale', desc:'Un comando manuale sospende le regole sulla luce per 30 minuti.' }
];

let client = null;
let session = null;
let home = null;
let devices = [];
let events = [];
let realtimeChannel = null;
let blackoutRunning = false;
let loadingData = false;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const nowTime = () => new Date().toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const esc = (v='') => String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const isDay = () => { const h = new Date().getHours(); return h >= 7 && h < 19; };

function setAuthMessage(text, bad=false){
  $('authMessage').textContent = text;
  $('authMessage').classList.toggle('error-text', bad);
}

function stateToValue(type, state){
  if(state == null) return null;
  if(typeof state !== 'object') return state;
  if(type === 'presence_sensor') return !!state.present;
  if(type === 'light' || type === 'switch') return !!state.on;
  if(type === 'vacuum' || type === 'media_player') return state.status ?? null;
  return state.value ?? null;
}
function valueToState(type, value){
  if(type === 'presence_sensor') return {present:!!value};
  if(type === 'light' || type === 'switch') return {on:!!value};
  if(type === 'vacuum' || type === 'media_player') return {status:String(value)};
  return {value};
}
function actualValue(d){ return stateToValue(d.device_type, d.actual_state); }
function desiredValue(d){ return stateToValue(d.device_type, d.desired_state); }
function isOverride(d){ return d.override_expires_at && new Date(d.override_expires_at).getTime() > Date.now(); }
function formatValue(d, value){
  if(!d.online) return 'OFFLINE';
  if(typeof value === 'boolean') return value ? (d.device_type === 'presence_sensor' ? 'PRESENZA' : 'ON') : (d.device_type === 'presence_sensor' ? 'ASSENZA' : 'OFF');
  if(value == null) return '—';
  return String(value).toUpperCase();
}

async function init(){
  try{
    const response = await fetch('/api/config', {cache:'no-store'});
    const config = await response.json();
    if(!response.ok) throw new Error(config.error || 'Configurazione Supabase mancante');
    if(!window.supabase?.createClient) throw new Error('Libreria Supabase non caricata');

    client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
    });

    const { data:{ session: current } } = await client.auth.getSession();
    session = current;
    client.auth.onAuthStateChange((_event, nextSession) => {
      session = nextSession;
      setTimeout(() => handleSession().catch(console.error), 0);
    });
    await handleSession();
  }catch(err){
    console.error(err);
    setAuthMessage(err.message, true);
  }
}

async function handleSession(){
  if(!session){
    if(realtimeChannel && client) await client.removeChannel(realtimeChannel);
    realtimeChannel = null;
    home = null; devices = []; events = [];
    $('authGate').hidden = false;
    $('appShell').hidden = true;
    setAuthMessage('Accedi oppure crea il tuo account Casa Live.');
    return;
  }

  $('authGate').hidden = true;
  $('appShell').hidden = false;
  $('systemStatus').textContent = 'Connessione Supabase…';
  try{
    await ensureHomeAndSeed();
    await loadAll();
    await subscribeRealtime();
    $('systemStatus').textContent = 'Sistema online';
    await addEvent('system_online', 'casa-live', {message:'Casa Live collegata a Supabase'});
  }catch(err){
    console.error(err);
    $('systemStatus').textContent = 'Errore Supabase';
    alert('Errore Supabase: ' + err.message);
  }
}

async function signIn(email, password){
  setAuthMessage('Accesso…');
  const { error } = await client.auth.signInWithPassword({email,password});
  if(error) throw error;
}
async function signUp(email, password){
  setAuthMessage('Creazione account…');
  const { data, error } = await client.auth.signUp({email,password});
  if(error) throw error;
  if(!data.session) setAuthMessage('Account creato. Controlla l’email di conferma e poi accedi.');
}

async function ensureHomeAndSeed(){
  const uid = session.user.id;
  let { data: homes, error } = await client.from('homes').select('*').order('created_at',{ascending:true}).limit(1);
  if(error) throw error;
  if(!homes.length){
    const created = await client.from('homes').insert({owner_id:uid,name:'Casa',timezone:'Europe/Rome',mode:'home'}).select().single();
    if(created.error) throw created.error;
    home = created.data;
  }else home = homes[0];

  let { data: roomRows, error: roomErr } = await client.from('rooms').select('*').eq('home_id',home.id);
  if(roomErr) throw roomErr;
  if(!roomRows.length){
    const seedRooms = ['Casa','Tettoia','Cucina','Soggiorno'].map((name,i)=>({home_id:home.id,name,sort_order:i}));
    const createdRooms = await client.from('rooms').insert(seedRooms).select();
    if(createdRooms.error) throw createdRooms.error;
    roomRows = createdRooms.data;
  }
  const roomMap = Object.fromEntries(roomRows.map(r=>[r.name,r.id]));

  const { data: existingDevices, error: devErr } = await client.from('devices').select('id').eq('home_id',home.id).limit(1);
  if(devErr) throw devErr;
  if(!existingDevices.length){
    const rows = DEMO_DEVICES.map(d=>({
      home_id:home.id,
      room_id:roomMap[d.room] || roomMap.Casa || null,
      external_id:d.external_id,
      name:d.name,
      device_type:d.device_type,
      provider:d.provider,
      capabilities:d.capabilities,
      metadata:{demo:true}
    }));
    const inserted = await client.from('devices').insert(rows).select();
    if(inserted.error) throw inserted.error;
    const states = inserted.data.map(d=>{
      let initial = false;
      if(d.device_type==='vacuum') initial='dock';
      if(d.device_type==='media_player') initial=d.external_id==='firetv'?'standby':'idle';
      const state = valueToState(d.device_type, initial);
      return { device_id:d.id, online:true, actual_state:state, desired_state:['light','switch'].includes(d.device_type)?state:null, source:'seed', observed_at:nowIso(), version:1 };
    });
    const stateInsert = await client.from('device_states').insert(states);
    if(stateInsert.error) throw stateInsert.error;
  }
}

async function loadAll(){
  if(!home || loadingData) return;
  loadingData = true;
  try{
    const [roomRes, devRes, eventRes, overrideRes] = await Promise.all([
      client.from('rooms').select('*').eq('home_id',home.id).order('sort_order'),
      client.from('devices').select('*').eq('home_id',home.id).eq('enabled',true),
      client.from('events').select('*').eq('home_id',home.id).order('occurred_at',{ascending:false}).limit(100),
      client.from('manual_overrides').select('*').eq('active',true)
    ]);
    for(const r of [roomRes,devRes,eventRes,overrideRes]) if(r.error) throw r.error;

    const roomMap = Object.fromEntries(roomRes.data.map(r=>[r.id,r.name]));
    const ids = devRes.data.map(d=>d.id);
    let stateRows = [];
    if(ids.length){
      const stateRes = await client.from('device_states').select('*').in('device_id',ids);
      if(stateRes.error) throw stateRes.error;
      stateRows = stateRes.data;
    }
    const stateMap = Object.fromEntries(stateRows.map(s=>[s.device_id,s]));
    const activeOverrides = overrideRes.data.filter(o => !o.expires_at || new Date(o.expires_at).getTime() > Date.now());
    const overrideMap = Object.fromEntries(activeOverrides.map(o=>[o.device_id,o]));

    devices = devRes.data.map(d=>({
      ...d,
      room:roomMap[d.room_id] || 'Senza stanza',
      online:stateMap[d.id]?.online ?? false,
      actual_state:stateMap[d.id]?.actual_state ?? {},
      desired_state:stateMap[d.id]?.desired_state ?? null,
      version:stateMap[d.id]?.version ?? 0,
      override_expires_at:overrideMap[d.id]?.expires_at ?? null
    }));
    events = eventRes.data;
    renderAll();
  }finally{
    loadingData = false;
  }
}

async function loadEvents(){
  if(!home) return;
  const { data, error } = await client.from('events').select('*').eq('home_id',home.id).order('occurred_at',{ascending:false}).limit(100);
  if(!error){ events=data; renderEvents(); }
}

async function subscribeRealtime(){
  if(realtimeChannel) await client.removeChannel(realtimeChannel);
  realtimeChannel = client.channel(`casa-live-${home.id}`)
    .on('postgres_changes',{event:'*',schema:'public',table:'device_states'},()=>loadAll())
    .on('postgres_changes',{event:'*',schema:'public',table:'events',filter:`home_id=eq.${home.id}`},()=>loadEvents())
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'homes',filter:`id=eq.${home.id}`},payload=>{
      home = {...home,...payload.new}; renderMode();
    })
    .subscribe(status=>{
      $('lastSync').textContent = status === 'SUBSCRIBED' ? 'Realtime collegato' : `Realtime: ${status}`;
    });
}

async function addEvent(type, source, payload={}, deviceId=null){
  if(!home) return;
  const { error } = await client.from('events').insert({home_id:home.id,device_id:deviceId,event_type:type,source,payload,occurred_at:nowIso()});
  if(error) console.error('Event insert', error);
}

async function writeDevice(d, {online=d.online, actual=actualValue(d), desired=desiredValue(d), source='Casa Live'}={}){
  const row = {
    device_id:d.id,
    online,
    actual_state:valueToState(d.device_type, actual),
    desired_state:desired == null ? null : valueToState(d.device_type, desired),
    source,
    observed_at:nowIso(),
    version:(d.version || 0)+1
  };
  const { error } = await client.from('device_states').upsert(row,{onConflict:'device_id'});
  if(error) throw error;
}

async function computeDesired(d){
  const mode = home?.mode || 'home';
  if(d.device_type === 'light' && !isOverride(d)){
    if(isDay() || mode==='away' || mode==='vacation') return false;
  }
  if(d.external_id === 'sonoff_ventole'){
    const p = devices.find(x=>x.external_id==='aqara_tettoia');
    return !!(p && actualValue(p));
  }
  return desiredValue(d);
}

async function reconcile(reason='Riconciliazione'){
  for(const d of [...devices]){
    if(!d.online || isOverride(d)) continue;
    const desired = await computeDesired(d);
    if(desired == null) continue;
    const actual = actualValue(d);
    if(actual !== desired){
      await addEvent('state_mismatch','reconciler',{name:d.name,actual,desired,reason},d.id);
      await writeDevice(d,{actual:desired,desired,source:'reconciler'});
      await addEvent('state_corrected','reconciler',{name:d.name,value:desired,reason},d.id);
    }else if(desiredValue(d) !== desired){
      await writeDevice(d,{actual,desired,source:'desired-state'});
    }
  }
}

async function manualToggle(id){
  const d = devices.find(x=>x.external_id===id);
  if(!d || !d.online || !['light','switch'].includes(d.device_type)) return;
  const next = !actualValue(d);
  await client.from('manual_overrides').update({active:false}).eq('device_id',d.id).eq('active',true);
  const expires = new Date(Date.now()+30*60*1000).toISOString();
  const { error } = await client.from('manual_overrides').insert({device_id:d.id,state:valueToState(d.device_type,next),expires_at:expires,reason:'Comando manuale da Casa Live'});
  if(error) throw error;
  await writeDevice(d,{actual:next,desired:next,source:'manual'});
  await addEvent('manual_override','app',{name:d.name,value:next,expires_at:expires},d.id);
}

async function togglePresence(){
  const d = devices.find(x=>x.external_id==='aqara_tettoia');
  if(!d) return;
  const next = !actualValue(d);
  await writeDevice(d,{actual:next,desired:null,source:'aqara-demo'});
  await addEvent(next?'presence_on':'presence_off','aqara-demo',{name:d.name},d.id);
  await loadAll();
  if(next){
    await addEvent('automation_wait','engine-demo',{rule:'Ventole su presenza',seconds:5},d.id);
    await sleep(5000);
    await loadAll();
    const current = devices.find(x=>x.external_id==='aqara_tettoia');
    if(current && actualValue(current)){
      await addEvent('automation_triggered','engine-demo',{rule:'Ventole su presenza'},current.id);
      await reconcile('Presenza Aqara confermata 5 s');
    }else{
      await addEvent('automation_cancelled','engine-demo',{rule:'Ventole su presenza'});
    }
  }else await reconcile('Fine presenza');
}

async function simulateBlackout(){
  if(blackoutRunning) return;
  blackoutRunning = true;
  $('blackoutBtn').disabled = true;
  try{
    await addEvent('blackout','demo',{message:'Dispositivi alimentati offline'});
    for(const d of devices){
      if(d.external_id!=='aqara_tettoia') await writeDevice(d,{online:false,source:'blackout-demo'});
    }
    await sleep(1200);
    await loadAll();
    await addEvent('power_restored','demo',{message:'Le luci simulano power-on = ON'});
    for(const d of devices){
      const actual = d.device_type==='light' ? true : actualValue(d);
      await writeDevice(d,{online:true,actual,desired:desiredValue(d),source:'power-restore-demo'});
    }
    await sleep(700);
    await loadAll();
    await reconcile('Ritorno online dopo blackout');
  }finally{
    blackoutRunning = false;
    $('blackoutBtn').disabled = false;
  }
}

async function cycleMode(){
  const current = MODE_ORDER.indexOf(home.mode || 'home');
  const next = MODE_ORDER[(current+1)%MODE_ORDER.length];
  const { error } = await client.from('homes').update({mode:next}).eq('id',home.id);
  if(error) throw error;
  home.mode=next;
  renderMode();
  await addEvent('home_mode_changed','app',{mode:next,label:MODE_LABELS[next]});
  await reconcile('Cambio modalità');
}

function renderMode(){ $('modeLabel').textContent = MODE_LABELS[home?.mode] || 'Casa'; }
function renderStats(){
  const online=devices.filter(d=>d.online).length;
  const on=devices.filter(d=>d.online && actualValue(d)===true && d.device_type!=='presence_sensor').length;
  const mismatch=devices.filter(d=>d.online && desiredValue(d)!=null && actualValue(d)!==desiredValue(d) && !isOverride(d)).length;
  $('stats').innerHTML=`<div class="stat"><span class="muted">Online</span><strong>${online}/${devices.length}</strong></div><div class="stat"><span class="muted">Accesi</span><strong>${on}</strong></div><div class="stat"><span class="muted">Da correggere</span><strong>${mismatch}</strong></div>`;
}
function renderDevices(){
  const groups=[...new Set(devices.map(d=>d.room))];
  $('rooms').innerHTML=groups.map(room=>{
    const rows=devices.filter(d=>d.room===room).map(d=>{
      const val=actualValue(d); const desired=desiredValue(d);
      const cls=!d.online?'offline':val===true?'on':'off';
      const canToggle=['light','switch'].includes(d.device_type);
      const override=isOverride(d)?' · override manuale':'';
      return `<div class="device"><div><div class="device-name">${esc(d.name)}</div><div class="device-meta">${esc(d.provider)} · ${esc(d.device_type)}${override}</div></div><div class="device-state"><span class="badge ${cls}">${esc(formatValue(d,val))}</span><span class="desired">desiderato: ${esc(formatValue({...d,online:true},desired))}</span>${canToggle?`<button class="secondary toggle" data-toggle="${esc(d.external_id)}" ${!d.online?'disabled':''}>Cambia</button>`:''}</div></div>`;
    }).join('');
    return `<article class="room-card"><div class="room-title">${esc(room)}</div>${rows}</article>`;
  }).join('');
  document.querySelectorAll('[data-toggle]').forEach(btn=>btn.addEventListener('click',()=>manualToggle(btn.dataset.toggle).catch(showError)));
}
function renderRules(){ $('rules').innerHTML=RULES.map((r,i)=>`<article class="rule"><div class="rule-index">${i+1}</div><div><div class="rule-title">${esc(r.title)}</div><div class="rule-desc">${esc(r.desc)}</div></div><div class="rule-status">ATTIVA</div></article>`).join(''); }
function eventTitle(e){
  const p=e.payload||{};
  const names={system_online:'Sistema collegato',blackout:'BLACKOUT simulato',power_restored:'Corrente ripristinata',state_mismatch:'Disallineamento rilevato',state_corrected:'Stato corretto',manual_override:'Override manuale',presence_on:'Presenza rilevata',presence_off:'Assenza rilevata',automation_wait:'Trigger in attesa',automation_triggered:'Automazione eseguita',automation_cancelled:'Automazione annullata',home_mode_changed:'Modalità casa cambiata'};
  return p.name ? `${names[e.event_type]||e.event_type} · ${p.name}` : (names[e.event_type]||e.event_type);
}
function eventDetail(e){
  const p=e.payload||{};
  if(p.message) return p.message;
  if(p.reason) return p.reason;
  if(p.rule) return p.rule;
  if(p.label) return p.label;
  if('value' in p) return `Valore: ${String(p.value)}`;
  return e.source;
}
function renderEvents(){
  $('events').innerHTML=events.length?events.map(e=>`<div class="event"><time>${new Date(e.occurred_at).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time><div><strong>${esc(eventTitle(e))}</strong><span class="muted">${esc(eventDetail(e))}</span></div></div>`).join(''):'<div class="event"><time>—</time><div><strong>Nessun evento</strong><span class="muted">Usa i pulsanti di test.</span></div></div>';
}
function renderAll(){ renderMode();renderStats();renderDevices();renderRules();renderEvents();$('lastSync').textContent='Aggiornato '+nowTime(); }
function showError(err){ console.error(err); alert(err?.message || String(err)); }

$('authForm').addEventListener('submit',async e=>{
  e.preventDefault();
  try{ await signIn($('authEmail').value.trim(),$('authPassword').value); }catch(err){ setAuthMessage(err.message,true); }
});
$('signUpBtn').addEventListener('click',async()=>{
  try{ await signUp($('authEmail').value.trim(),$('authPassword').value); }catch(err){ setAuthMessage(err.message,true); }
});
$('logoutBtn').addEventListener('click',()=>client?.auth.signOut().catch(showError));
$('cycleMode').addEventListener('click',()=>cycleMode().catch(showError));
$('presenceBtn').addEventListener('click',()=>togglePresence().catch(showError));
$('blackoutBtn').addEventListener('click',()=>simulateBlackout().catch(showError));
$('reconcileBtn').addEventListener('click',()=>reconcile('Controllo manuale').catch(showError));
$('clearLog').addEventListener('click',()=>{ events=[];renderEvents(); });

if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
setInterval(() => { if(session && home) reconcile('Controllo periodico').catch(console.error); }, 60_000);
init();
