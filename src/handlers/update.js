import { saveMetricsHistory } from '../database/schema.js';
import { getServerDetail } from '../utils/cache.js';
import { createErrorResponse, createUnauthorizedResponse, createNotFoundResponse } from '../utils/errors.js';
import { loadSiteSettings } from '../utils/settings.js';
import { normalizeThemeUrl } from '../utils/theme.js';
import { applyThemeTrafficCompatibility } from '../utils/traffic.js';

const THEME_SETTINGS_TTL = 60 * 1000;
let themeSettingsCache = { enabled: false, expiresAt: 0 };

async function isThirdPartyThemeEnabled(db) {
  const now = Date.now();
  if (themeSettingsCache.expiresAt > now) return themeSettingsCache.enabled;

  try {
    const settings = await loadSiteSettings(db);
    const enabled = !!normalizeThemeUrl(settings?.theme_url);
    themeSettingsCache = { enabled, expiresAt: now + THEME_SETTINGS_TTL };
    return enabled;
  } catch (e) {
    console.warn('[theme] Failed to load theme settings for live update:', e.message || e);
    themeSettingsCache = { enabled: false, expiresAt: now + THEME_SETTINGS_TTL };
    return false;
  }
}

// 将最新一次上报打包成前端可直接消费的 "当前状态" 对象
// 与 /api/server 和 /api/servers 返回的字段保持一致，便于页面直接合并
function buildPayloadForBroadcast(id, metrics, extra = {}) {
  const source = metrics || {};
  const ts = source.timestamp || Date.now();
  return {
    id,
    cpu: source.cpu ?? null,
    ram: source.ram ?? null,
    disk: source.disk ?? null,
    load_avg: source.load ?? source.load_avg ?? '0 0 0',
    net_in_speed: source.net_in_speed ?? null,
    net_out_speed: source.net_out_speed ?? null,
    net_rx: source.net_rx ?? null,
    net_tx: source.net_tx ?? null,
    net_rx_monthly: source.net_rx_monthly ?? null,
    net_tx_monthly: source.net_tx_monthly ?? null,
    traffic_raw_rx_monthly: source.traffic_raw_rx_monthly ?? source.net_rx_monthly ?? null,
    traffic_raw_tx_monthly: source.traffic_raw_tx_monthly ?? source.net_tx_monthly ?? null,
    traffic_display_adjusted: source.traffic_display_adjusted === true,
    traffic_period_start: source.traffic_period_start ?? null,
    processes: source.processes ?? null,
    tcp_conn: source.tcp_conn ?? null,
    udp_conn: source.udp_conn ?? null,
    ping_ct: source.ping_ct ?? null,
    ping_cu: source.ping_cu ?? null,
    ping_cm: source.ping_cm ?? null,
    ping_bd: source.ping_bd ?? null,
    ram_total: source.ram_total ?? null,
    ram_used: source.ram_used ?? null,
    swap_total: source.swap_total ?? null,
    swap_used: source.swap_used ?? null,
    disk_total: source.disk_total ?? null,
    disk_used: source.disk_used ?? null,
    cpu_cores: source.cpu_cores ?? null,
    cpu_info: source.cpu_info ?? '',
    arch: source.arch ?? '',
    os: source.os ?? '',
    country: source.country || extra.country || '',
    ip_v4: source.ip_v4 ?? '0',
    ip_v6: source.ip_v6 ?? '0',
    boot_time: source.boot_time ?? '',
    last_updated: ts,
    timestamp: ts
  };
}

// 内部辅助：向 Durable Object 发送广播
async function broadcastToDO(env, serverId, payload) {
  if (!env || !env.METRICS_BROADCASTER) return false;
  try {
    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    // 内部调用，不需要鉴权；即使失败也不影响 /update 返回
    await stub.fetch(`http://internal/push/${encodeURIComponent(serverId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return true;
  } catch (e) {
    // 广播失败不应该让客户端收到错误
    console.warn('[broadcast] DO push failed:', e.message || e);
    return false;
  }
}

export async function handleUpdate(request, env, ctx) {
  try {
    const data = await request.json();
    const { id, secret, metrics } = data;

    if (secret !== env.API_SECRET) {
      return createUnauthorizedResponse('Invalid secret');
    }

    let countryCode = request.cf?.country || '';
    if (countryCode.toUpperCase() === 'TW') countryCode = 'CN';

    const server = await getServerDetail(env.DB, id, true);

    if (!server) {
      return createNotFoundResponse('Server not found');
    }

    await saveMetricsHistory(env.DB, id, metrics, countryCode);

    const themeEnabled = await isThirdPartyThemeEnabled(env.DB);
    const displayMetrics = applyThemeTrafficCompatibility(
      { ...server, ...(metrics || {}) },
      themeEnabled
    );
    const payload = buildPayloadForBroadcast(id, displayMetrics, { country: countryCode });
    ctx.waitUntil(broadcastToDO(env, id, payload));

    return new Response('OK', { status: 200 });
  } catch (e) {
    return createErrorResponse(e);
  }
}

// 暴露给 index.js 路由使用的 WebSocket 接入函数
export async function handleWebSocketUpgrade(request, env) {
  if (!env || !env.METRICS_BROADCASTER) {
    return new Response(JSON.stringify({ error: 'WebSocket not enabled', code: 503 }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const url = new URL(request.url);
  // 透传 query 让 DO 读取 subscribe 参数
  const qs = url.search || '';
  try {
    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    return await stub.fetch(`http://internal/ws${qs}`, {
      method: request.method,
      headers: request.headers
    });
  } catch (e) {
    console.error('[ws] DO upgrade failed:', e);
    return new Response(JSON.stringify({ error: 'WebSocket error', code: 500 }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
