import { initDatabase, cleanupOldData, getMetricsHistory, rebuildDatabase } from './database/schema.js';
import { checkOfflineNodes } from './services/notification.js';
import { updateDatabase } from './database/updateDatabase.js';
import { handleAdminAPI } from './handlers/admin.js';
import { serveFrontend } from './handlers/frontend.js';
import { handleUpdate, handleWebSocketUpgrade } from './handlers/update.js';
import { handleServerAPI, handleServersAPI } from './handlers/dashboard.js';
import { isValidThemeOptions, loadSettings, loadSiteSettings, saveThemeOptions } from './utils/settings.js';
import { normalizeThemeUrl } from './utils/theme.js';
import { applyThemeHistoryCompatibility } from './utils/traffic.js';
import { checkAuth, simpleAuthResponse } from './middleware/auth.js';
import { getServerDetail, getMetricsHistoryCache, setMetricsHistoryCache } from './utils/cache.js';
import { createSuccessResponse, createUnauthorizedResponse, createBadRequestResponse } from './utils/errors.js';

const CURRENT_VERSION = '2.6.5';

// Durable Objects: 实时指标广播
// 显式 import + extends，确保 wrangler 静态分析器能在入口文件直接识别此 DO 类
import { MetricsBroadcaster as _MetricsBroadcaster }
  from './durable/MetricsBroadcaster.js';

export class MetricsBroadcaster extends _MetricsBroadcaster {}


async function getEncryptionKey(env) {
  const secret = env.TURNSTILE_SECRET_KEY || env.API_SECRET || 'default_secret_key_for_turnstile_encryption';
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(hash).slice(0, 32),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  return keyMaterial;
}

async function encryptCookieData(data, env) {
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const encodedData = encoder.encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encodedData
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptCookieData(encoded, env) {
  try {
    const key = await getEncryptionKey(env);
    const decoded = new Uint8Array(atob(encoded).split('').map(c => c.charCodeAt(0)));
    const iv = decoded.slice(0, 12);
    const ciphertext = decoded.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      ciphertext
    );
    const encoder = new TextDecoder();
    return JSON.parse(encoder.decode(decrypted));
  } catch (e) {
    console.error('Cookie decryption error:', e);
    return null;
  }
}

async function verifyTurnstileToken(token, secretKey) {
  if (!token || !secretKey) {
    return false;
  }
  
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        secret: secretKey,
        response: token
      })
    });
    
    const data = await response.json();
    return data.success === true;
  } catch (e) {
    console.error('Turnstile verification error:', e);
    return false;
  }
}

async function fetchHistoryData(env, request, id, hours, columns, sys = null) {
  if (!id) return createBadRequestResponse('Missing ID');
  
  if (!sys) {
    sys = await loadSettings(env.DB);
  }
  const isLoggedIn = await checkAuth(request, env, sys);
  
  if (sys.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }
  
  if (hours > 1 && !isLoggedIn) {
    return createUnauthorizedResponse();
  }
  
  const server = await getServerDetail(env.DB, id, isLoggedIn);
  if (!server) return new Response('Not Found', { status: 404 });
  
  const clampedHours = Math.min(hours, 72);
  
  const cached = getMetricsHistoryCache(id, clampedHours, columns);
  if (cached && Date.now() - cached.timestamp < 60000) {
    const themeEnabled = !!normalizeThemeUrl(sys.theme_url);
    return createSuccessResponse(
      applyThemeHistoryCompatibility(cached.data, themeEnabled),
      { 'X-Cache': 'HIT' }
    );
  }
  
  const data = await getMetricsHistory(env.DB, id, clampedHours, columns);
  
  setMetricsHistoryCache(id, clampedHours, columns, data);

  const themeEnabled = !!normalizeThemeUrl(sys.theme_url);
  return createSuccessResponse(
    applyThemeHistoryCompatibility(data, themeEnabled),
    { 'X-Cache': 'MISS' }
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    if (!env.API_SECRET || env.API_SECRET.length === 0) {
      return createBadRequestResponse('API_SECRET is required');
    }

    const bypassTurnstilePaths = [
      '/update',
      '/admin/api',
      '/api/config',
      '/favicon.ico',
      '/logo.svg',
      '/install.sh'
    ];

    const isApiRequest = path.startsWith('/api/') || path.startsWith('/admin/api');
    if (path === '/api/config' || path === '/api/theme_options' || path === '/rebuild') {
      await initDatabase(env.DB);
    }

    let setTurnstileCookie = false;
    let sys = null;
    
    if (isApiRequest && !bypassTurnstilePaths.includes(path)) {
      sys = await loadSiteSettings(env.DB);
      const turnstileEnabled = sys.turnstile_enabled === 'true';
      const turnstileSecretKey = sys.turnstile_secret_key || '';
      
      if (turnstileEnabled) {
        const cookies = request.headers.get('Cookie') || '';
        const turnstileCookie = cookies.split(';').find(c => c.trim().startsWith('turnstile_verified='));
        
        let hasValidCookie = false;
        if (turnstileCookie) {
          const encryptedData = turnstileCookie.split('=')[1];
          const decrypted = await decryptCookieData(encryptedData, env);
          if (decrypted && decrypted.expires && Date.now() < decrypted.expires * 1000) {
            hasValidCookie = true;
          }
        }
        
        if (!hasValidCookie) {
          const turnstileToken = request.headers.get('X-Turnstile-Token');
          const isVerified = await verifyTurnstileToken(turnstileToken, turnstileSecretKey);
          
          if (!isVerified) {
            return new Response(JSON.stringify({ error: 'Turnstile verification failed', code: 403 }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          
          setTurnstileCookie = true;
        }
      }
    }

    async function ensureSiteSettings() {
      if (!sys) {
        sys = await loadSiteSettings(env.DB);
      }
      return sys;
    }

    async function ensureFullSettings() {
      if (!sys || sys.theme_options === undefined) {
        sys = await loadSettings(env.DB);
      }
      return sys;
    }

    const routes = [
      { method: 'POST', path: '/update', handler: () => handleUpdate(request, env, ctx) },
      { method: 'GET', path: '/__do/health', handler: async () => {
        if (!env.METRICS_BROADCASTER) {
          return createSuccessResponse({ ok: false, reason: 'DO not bound' });
        }
        try {
          const id = env.METRICS_BROADCASTER.idFromName('global');
          const stub = env.METRICS_BROADCASTER.get(id);
          return await stub.fetch('http://internal/health');
        } catch (e) {
          return createSuccessResponse({ ok: false, reason: e.message });
        }
      }},
      { method: 'GET', path: '/api/config', handler: async () => {
        await ensureFullSettings();
        const turnstileEnabled = sys.turnstile_enabled === 'true';
        const isLoggedIn = await checkAuth(request, env, sys);
        let cookieAuth = false;
        
        if (turnstileEnabled) {
          const cookies = request.headers.get('Cookie') || '';
          const turnstileCookie = cookies.split(';').find(c => c.trim().startsWith('turnstile_verified='));
          
          if (turnstileCookie) {
            const encryptedData = turnstileCookie.split('=')[1];
            const decrypted = await decryptCookieData(encryptedData, env);
            if (decrypted && decrypted.expires && Date.now() < decrypted.expires * 1000) {
              cookieAuth = true;
            }
          }
        }
        
        return createSuccessResponse({
          version: CURRENT_VERSION,
          site_title: sys.site_title || 'Cloudflare Server Monitor',
          is_public: sys.is_public === 'true',
          authorization: isLoggedIn,
          turnstile_enabled: turnstileEnabled,
          turnstile_login_enabled: turnstileEnabled,
          turnstile_site_key: sys.turnstile_site_key || '',
          cookie_auth: cookieAuth,
          preferred_theme: 'auto',
          default_language: 'auto',
          display_mode: 'bar',
          theme_options: sys.theme_options || {},
          long_history_points: 120,
          frontend_ws_timeout_minutes: 0,
          custom_ct_name: '电信',
          custom_cu_name: '联通',
          custom_cm_name: '移动',
          custom_bd_name: 'BGP'
        });
      }},
      { method: 'POST', path: '/api/theme_options', handler: async () => {
        await ensureFullSettings();
        if (!await checkAuth(request, env, sys)) {
          return simpleAuthResponse();
        }

        let data;
        try {
          data = await request.json();
        } catch (_) {
          return createBadRequestResponse('Invalid JSON');
        }

        if (!isValidThemeOptions(data?.theme_options)) {
          return createBadRequestResponse('Invalid theme options format');
        }

        await saveThemeOptions(env.DB, data.theme_options);
        sys.theme_options = data.theme_options;
        return createSuccessResponse({
          success: true,
          theme_options: data.theme_options,
          message: 'Update Success'
        });
      }},
      { method: 'GET', path: '/api/server', handler: async () => {
        await ensureSiteSettings();
        return handleServerAPI(request, env, sys);
      }},
      { method: 'GET', path: '/api/servers', handler: async () => {
        await ensureFullSettings();
        return handleServersAPI(request, env, sys);
      }},
      { method: 'GET', path: '/api/ws', handler: async () => handleWebSocketUpgrade(request, env) },

      { method: 'GET', path: '/api/history/all', handler: async () => {
        await ensureSiteSettings();
        const id = url.searchParams.get('id');
        const hours = parseFloat(url.searchParams.get('hours') || '24');
        const allColumns = 'cpu, ram, disk, processes, net_in_speed, net_out_speed, tcp_conn, udp_conn, ping_ct, ping_cu, ping_cm, ping_bd, swap_total, swap_used, load_avg';
        return fetchHistoryData(env, request, id, hours, allColumns, sys);
      }},
      { method: 'POST', path: '/admin/api', handler: async () => {
        await ensureFullSettings();
        return handleAdminAPI(request, env, sys);
      }},
      { method: 'GET', path: '/updateDatabase', handler: async () => {
        await ensureSiteSettings();
        if (!await checkAuth(request, env, sys)) {
          return simpleAuthResponse();
        }
        const result = await updateDatabase(env.DB);
        return createSuccessResponse(result);
      }},
      { method: 'GET', path: '/rebuild', handler: async () => {
        await ensureSiteSettings();
        if (!await checkAuth(request, env, sys)) {
          return simpleAuthResponse();
        }
        const result = await rebuildDatabase(env.DB);
        return createSuccessResponse(result);
      }}
    ];

    for (const route of routes) {
      if (route.method === method && route.path === path) {
        const response = await route.handler();
        
        if (setTurnstileCookie && response) {
          const expires = Math.floor(Date.now() / 1000) + 3600;
          const cookieData = { expires, verified: true, timestamp: Date.now() };
          const encryptedCookie = await encryptCookieData(cookieData, env);
          
          const newHeaders = new Headers(response.headers);
          newHeaders.set('Set-Cookie', `turnstile_verified=${encryptedCookie}; path=/; max-age=3600; SameSite=Lax; HttpOnly`);
          
          const newResponse = new Response(response.body, {
            status: response.status,
            headers: newHeaders
          });
          return newResponse;
        }
        
        return response;
      }
    }

    await ensureFullSettings();

    // Let the configured third-party theme claim /assets/* before Workers
    // Static Assets, otherwise a same-named built-in bundle can be returned.
    const themeOwnsAssets = method === 'GET' && path.startsWith('/assets/') && normalizeThemeUrl(sys?.theme_url);
    if (env.ASSETS && method === 'GET' && !themeOwnsAssets) {
      try {
        const res = await env.ASSETS.fetch(new Request(`http://static${path}`, request));
        if (res.ok) {
          return res;
        }
      } catch (e) {
      }
    }

    return serveFrontend(request, env, sys);
  },

  async scheduled(event, env, ctx) {
    const cron = event.cron;
    console.log(`[Cron] 定时任务触发: ${cron}`);
    
    if (cron === '50 23 * * *') {
      console.log('[Cron] 开始执行每日数据清理任务');
      await cleanupOldData(env.DB);
      console.log('[Cron] 每日数据清理任务完成');
    } else if (cron === '*/1 * * * *') {
      console.log('[Cron] 开始执行离线节点检测');
      await checkOfflineNodes(env.DB);
      console.log('[Cron] 离线节点检测完成');
    }
  }
};
