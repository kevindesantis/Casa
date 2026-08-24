const ENGINE_VERSION = '3.0.0';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.APP_ORIGIN || '*';
  const allowOrigin = allowed === '*' || origin === allowed ? (allowed === '*' ? '*' : origin) : allowed;
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-casa-live-provider-secret',
    'access-control-max-age': '86400',
    'vary': 'Origin'
  };
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function supabaseUrl(env, path) {
  return `${env.SUPABASE_URL.replace(/\/$/, '')}${path}`;
}

async function supabaseRequest(env, path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('apikey', env.SUPABASE_SECRET_KEY);
  if (options.body != null && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(supabaseUrl(env, path), { ...options, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase ${response.status}: ${text.slice(0, 500)}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function validateUser(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) throw new Error('AUTH_REQUIRED');
  const response = await fetch(supabaseUrl(env, '/auth/v1/user'), {
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      authorization: auth
    }
  });
  if (!response.ok) throw new Error('AUTH_INVALID');
  return response.json();
}

function stateToValue(type, state) {
  if (state == null) return null;
  if (typeof state !== 'object') return state;
  if (type === 'presence_sensor') return !!state.present;
  if (type === 'light' || type === 'switch') return !!state.on;
  if (type === 'vacuum' || type === 'media_player') return state.status ?? null;
  return state.value ?? null;
}

function valueToState(type, value) {
  if (type === 'presence_sensor') return { present: !!value };
  if (type === 'light' || type === 'switch') return { on: !!value };
  if (type === 'vacuum' || type === 'media_player') return { status: String(value) };
  return { value };
}

function isDayInTimezone(timezone = 'Europe/Rome') {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date());
    const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 12);
    // V3 baseline. In the next step this can become sunrise/sunset using home latitude/longitude.
    return hour >= 7 && hour < 19;
  } catch {
    const hour = new Date().getUTCHours();
    return hour >= 5 && hour < 17;
  }
}

function overrideIsActive(override) {
  if (!override) return false;
  if (!override.expires_at) return true;
  return new Date(override.expires_at).getTime() > Date.now();
}

async function insertEvent(env, homeId, deviceId, eventType, source, payload = {}) {
  await supabaseRequest(env, '/rest/v1/events', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      home_id: homeId,
      device_id: deviceId || null,
      event_type: eventType,
      source,
      payload,
      occurred_at: new Date().toISOString()
    })
  });
}

async function updateDeviceState(env, device, current, { online, actual, desired, source }) {
  const row = {
    device_id: device.id,
    online: online ?? current.online ?? false,
    actual_state: actual === undefined ? (current.actual_state || {}) : actual,
    desired_state: desired === undefined ? (current.desired_state ?? null) : desired,
    source,
    observed_at: new Date().toISOString(),
    version: Number(current.version || 0) + 1
  };
  await supabaseRequest(env, '/rest/v1/device_states?on_conflict=device_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row)
  });
  return row;
}

async function hasPendingCommand(env, deviceId) {
  const rows = await supabaseRequest(env,
    `/rest/v1/command_history?device_id=eq.${encodeURIComponent(deviceId)}&status=in.(queued,sent)&select=id&limit=1`
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function queueCommand(env, homeId, device, desiredState, reason) {
  if (await hasPendingCommand(env, device.id)) return false;
  await supabaseRequest(env, '/rest/v1/command_history', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      home_id: homeId,
      device_id: device.id,
      requested_state: desiredState,
      reason,
      status: 'queued',
      attempts: 0
    })
  });
  await insertEvent(env, homeId, device.id, 'command_queued', 'cloud-engine', {
    name: device.name,
    provider: device.provider,
    desired_state: desiredState,
    reason
  });
  return true;
}

async function loadHomeSnapshot(env, homeId) {
  const homes = await supabaseRequest(env,
    `/rest/v1/homes?id=eq.${encodeURIComponent(homeId)}&select=id,owner_id,mode,timezone,latitude,longitude,name&limit=1`
  );
  if (!homes?.length) throw new Error('HOME_NOT_FOUND');
  const home = homes[0];

  const devices = await supabaseRequest(env,
    `/rest/v1/devices?home_id=eq.${encodeURIComponent(homeId)}&enabled=eq.true&select=id,external_id,name,device_type,provider,metadata`
  );
  if (!devices?.length) return { home, devices: [], states: new Map(), overrides: new Map() };

  const ids = devices.map(d => d.id).join(',');
  const states = await supabaseRequest(env,
    `/rest/v1/device_states?device_id=in.(${ids})&select=device_id,online,actual_state,desired_state,source,observed_at,version`
  );
  const overrides = await supabaseRequest(env,
    `/rest/v1/manual_overrides?device_id=in.(${ids})&active=eq.true&select=device_id,expires_at,state,active`
  );
  return {
    home,
    devices,
    states: new Map((states || []).map(s => [s.device_id, s])),
    overrides: new Map((overrides || []).filter(overrideIsActive).map(o => [o.device_id, o]))
  };
}

function computeDesired(home, device, state, allDevices, states) {
  if (device.device_type === 'light') {
    if (home.mode === 'away' || home.mode === 'vacation' || isDayInTimezone(home.timezone)) {
      return false;
    }
  }

  if (device.external_id === 'sonoff_ventole') {
    const presence = allDevices.find(d => d.external_id === 'aqara_tettoia');
    if (presence) {
      const pState = states.get(presence.id);
      return !!stateToValue(presence.device_type, pState?.actual_state);
    }
  }

  return stateToValue(device.device_type, state?.desired_state);
}

async function reconcileHome(env, homeId, reason = 'Cloud reconcile') {
  const snapshot = await loadHomeSnapshot(env, homeId);
  const { home, devices, states, overrides } = snapshot;
  const summary = { homeId, checked: 0, corrected: 0, queued: 0, skipped: 0, at: new Date().toISOString() };

  for (const device of devices) {
    const state = states.get(device.id);
    if (!state || !state.online || overrides.has(device.id)) {
      summary.skipped++;
      continue;
    }

    const desiredValue = computeDesired(home, device, state, devices, states);
    if (desiredValue == null) {
      summary.skipped++;
      continue;
    }
    summary.checked++;

    const actualValue = stateToValue(device.device_type, state.actual_state);
    const desiredState = valueToState(device.device_type, desiredValue);

    if (actualValue === desiredValue) {
      if (JSON.stringify(state.desired_state) !== JSON.stringify(desiredState)) {
        await updateDeviceState(env, device, state, { desired: desiredState, source: 'cloud-desired-state' });
      }
      continue;
    }

    const isDemo = device.metadata?.demo === true;
    if (isDemo) {
      await insertEvent(env, home.id, device.id, 'state_mismatch', 'cloud-engine', {
        name: device.name,
        actual: actualValue,
        desired: desiredValue,
        reason
      });
      await updateDeviceState(env, device, state, {
        actual: desiredState,
        desired: desiredState,
        source: 'cloud-reconciler'
      });
      await insertEvent(env, home.id, device.id, 'state_corrected', 'cloud-engine', {
        name: device.name,
        value: desiredValue,
        reason
      });
      summary.corrected++;
    } else {
      await updateDeviceState(env, device, state, { desired: desiredState, source: 'cloud-desired-state' });
      if (await queueCommand(env, home.id, device, desiredState, reason)) summary.queued++;
    }
  }

  return summary;
}

async function triggerHomeEngine(env, homeId, reason) {
  const id = env.HOME_ENGINE.idFromName(homeId);
  const stub = env.HOME_ENGINE.get(id);
  const response = await stub.fetch('https://home-engine.internal/reconcile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ homeId, reason })
  });
  if (!response.ok) throw new Error(`HOME_ENGINE_${response.status}`);
  return response.json();
}

async function verifyHomeOwner(env, homeId, userId) {
  const rows = await supabaseRequest(env,
    `/rest/v1/homes?id=eq.${encodeURIComponent(homeId)}&owner_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`
  );
  return !!rows?.length;
}

async function ingestProviderEvent(request, env) {
  if (!env.PROVIDER_INGEST_SECRET || request.headers.get('x-casa-live-provider-secret') !== env.PROVIDER_INGEST_SECRET) {
    return json({ error: 'Unauthorized provider event' }, 401, corsHeaders(request, env));
  }
  const body = await readJson(request);
  const { homeId, provider, externalId, online = true, actualState, eventType = 'provider_state', payload = {} } = body;
  if (!homeId || !provider || !externalId || actualState == null) {
    return json({ error: 'homeId, provider, externalId e actualState sono obbligatori' }, 400, corsHeaders(request, env));
  }

  const rows = await supabaseRequest(env,
    `/rest/v1/devices?home_id=eq.${encodeURIComponent(homeId)}&provider=eq.${encodeURIComponent(provider)}&external_id=eq.${encodeURIComponent(externalId)}&select=id,name,device_type,provider,external_id&limit=1`
  );
  if (!rows?.length) return json({ error: 'Device not found' }, 404, corsHeaders(request, env));
  const device = rows[0];
  const stateRows = await supabaseRequest(env,
    `/rest/v1/device_states?device_id=eq.${encodeURIComponent(device.id)}&select=*&limit=1`
  );
  const current = stateRows?.[0] || { device_id: device.id, version: 0, desired_state: null };
  await updateDeviceState(env, device, current, {
    online: !!online,
    actual: actualState,
    desired: current.desired_state,
    source: `${provider}-event`
  });
  await insertEvent(env, homeId, device.id, eventType, provider, { ...payload, name: device.name });
  const result = await triggerHomeEngine(env, homeId, `Evento realtime ${provider}`);
  return json({ accepted: true, reconciliation: result }, 202, corsHeaders(request, env));
}

export class HomeEngine {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/reconcile' || request.method !== 'POST') return json({ error: 'Not found' }, 404);
    const body = await readJson(request);
    if (!body.homeId) return json({ error: 'homeId required' }, 400);

    const started = Date.now();
    try {
      const summary = await reconcileHome(this.env, body.homeId, body.reason || 'Durable Object reconcile');
      summary.durationMs = Date.now() - started;
      await this.ctx.storage.put('lastSummary', summary);
      return json(summary);
    } catch (error) {
      const failure = { homeId: body.homeId, error: error.message, at: new Date().toISOString() };
      await this.ctx.storage.put('lastError', failure);
      return json(failure, 500);
    }
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({
        ok: true,
        service: 'casa-live-engine',
        version: ENGINE_VERSION,
        mode: 'realtime-events + 1-minute safety reconcile'
      }, 200, cors);
    }

    if (url.pathname === '/reconcile' && request.method === 'POST') {
      try {
        const user = await validateUser(request, env);
        const body = await readJson(request);
        if (!body.homeId) return json({ error: 'homeId required' }, 400, cors);
        if (!(await verifyHomeOwner(env, body.homeId, user.id))) return json({ error: 'Forbidden' }, 403, cors);
        const result = await triggerHomeEngine(env, body.homeId, body.reason || 'Richiesta app');
        return json({ ok: true, ...result }, 200, cors);
      } catch (error) {
        const status = error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_INVALID' ? 401 : 500;
        return json({ error: error.message }, status, cors);
      }
    }

    if (url.pathname === '/provider-event' && request.method === 'POST') {
      try { return await ingestProviderEvent(request, env); }
      catch (error) { return json({ error: error.message }, 500, cors); }
    }

    return json({ error: 'Not found' }, 404, cors);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => {
      const homes = await supabaseRequest(env, '/rest/v1/homes?select=id&order=created_at.asc&limit=1000');
      for (const home of homes || []) {
        try {
          await triggerHomeEngine(env, home.id, 'Controllo di sicurezza ogni minuto');
        } catch (error) {
          console.error('Scheduled reconcile failed', home.id, error);
        }
      }
    })());
  }
};
