import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import {
  getDashboardLatencyHistory,
  getLatestMetrics,
  getLatestMetricsForAllServers,
  getAllServers
} from '../database/schema.js';
import { getServerDetail } from '../utils/cache.js';
import { mergeMetricsIntoServer } from '../utils/metrics.js';
import { createSuccessResponse, createBadRequestResponse, createNotFoundResponse } from '../utils/errors.js';
import { normalizeThemeUrl } from '../utils/theme.js';
import { applyThemeTrafficCompatibility } from '../utils/traffic.js';
import {
  DASHBOARD_LATENCY_WINDOW_HOURS,
  DASHBOARD_LATENCY_WINDOW_POINTS
} from '../utils/config.js';

function attachLatencyHistoryToServers(servers, latencyHistory) {
  for (const server of servers || []) {
    const window = latencyHistory?.get(String(server.id));
    server.ping = window?.ping || [];
    server.loss = window?.loss || [];
  }
}

function addThemeCompatibilityFields(server) {
  server.region = server.region || server.country || '';
  server.traffic_calc_type = server.traffic_count_mode === 'rx'
    ? 'down'
    : server.traffic_count_mode === 'tx'
      ? 'up'
      : 'sum';
  server.reset_day = Number(server.traffic_reset_day) || 0;
  return server;
}

function buildThemeSysConfig(sys) {
  return {
    show_price: sys.show_price === 'true',
    show_expire: sys.show_expire === 'true',
    show_tf: sys.show_tf === 'true',
    show_time: true,
    show_three_net_details: true,
    long_history_points: 120,
    site_title: sys.site_title || 'Server Monitor'
  };
}

export async function handleServerAPI(request, env, sys) {
  const isLoggedIn = await checkAuth(request, env, sys);
  
  if (sys.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }
  
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  
  if (!id) return createBadRequestResponse('Missing ID');
  
  const serverRecord = await getServerDetail(env.DB, id, isLoggedIn);
  if (!serverRecord) return createNotFoundResponse('Server not found');
  const server = { ...serverRecord };
  
  const latestMetrics = await getLatestMetrics(env.DB, id);
  mergeMetricsIntoServer(server, latestMetrics);
  addThemeCompatibilityFields(server);
  const displayedServer = applyThemeTrafficCompatibility(server, !!normalizeThemeUrl(sys.theme_url));
  displayedServer.sysConfig = buildThemeSysConfig(sys);
  
  return createSuccessResponse(displayedServer);
}

export async function handleServersAPI(request, env, sys) {
  const isLoggedIn = await checkAuth(request, env, sys);
  
  if (sys.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }
  
  const results = (await getAllServers(env.DB, isLoggedIn)).map(server => ({ ...server }));
  const themeEnabled = !!normalizeThemeUrl(sys.theme_url);

  const [latestMetricsMap, latencyHistory] = await Promise.all([
    getLatestMetricsForAllServers(env.DB),
    themeEnabled
      ? getDashboardLatencyHistory(env.DB, results)
      : Promise.resolve(new Map())
  ]);
  attachLatencyHistoryToServers(results, latencyHistory);
  
  const now = Date.now();
  let globalOnline = 0;
  let globalSpeedIn = 0, globalSpeedOut = 0, globalNetTx = 0, globalNetRx = 0;
  const countryStats = {};
  
  for (let index = 0; index < results.length; index++) {
    const server = { ...results[index] };
    const latestMetrics = latestMetricsMap.get(server.id);
    
    let isOnline = false;
    
    if (latestMetrics) {
      isOnline = (now - latestMetrics.timestamp) < 300000;
      mergeMetricsIntoServer(server, latestMetrics);
    }

    addThemeCompatibilityFields(server);
    const displayedServer = applyThemeTrafficCompatibility(server, themeEnabled);
    results[index] = displayedServer;
    
    if (isOnline) {
      globalOnline++;
      globalSpeedIn += parseFloat(server.net_in_speed) || 0;
      globalSpeedOut += parseFloat(server.net_out_speed) || 0;
    }
    
    globalNetRx += parseFloat(server.net_rx || 0);
    globalNetTx += parseFloat(server.net_tx || 0);
    
    let cCode = (server.country || '').toUpperCase();
    if (cCode === 'TW') cCode = 'CN';
    if (cCode !== '') {
      countryStats[cCode] = (countryStats[cCode] || 0) + 1;
    }
  }
  
  const globalOffline = results.length - globalOnline;

  const data = {
    servers: results,
    stats: {
      total: results.length,
      online: globalOnline,
      offline: globalOffline,
      globalSpeedIn,
      globalSpeedOut,
      globalNetTx,
      globalNetRx
    },
    countryStats,
    regionStats: countryStats,
    latestMetricsMap: Object.fromEntries(latestMetricsMap),
    sysConfig: {
      show_price: sys.show_price === 'true',
      show_expire: sys.show_expire === 'true',
      show_bw: sys.show_bw === 'true',
      show_tf: sys.show_tf === 'true',
      show_time: true,
      show_three_net_details: true,
      latency_window: {
        points: DASHBOARD_LATENCY_WINDOW_POINTS,
        hours: DASHBOARD_LATENCY_WINDOW_HOURS
      },
      long_history_points: 120,
      site_title: sys.site_title || 'Server Monitor'
    }
  };

  return createSuccessResponse(data);
}

