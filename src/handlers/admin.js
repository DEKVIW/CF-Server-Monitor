import { checkAuth, simpleAuthResponse, validateCredentials, generateToken } from '../middleware/auth.js';
import { clearNotificationSettingsCache } from '../services/notification.js';
import { getLatestMetricsForAllServers, getAllServers } from '../database/schema.js';
import { clearServersListCache, clearServerDetailCache } from '../utils/cache.js';
import { mergeMetricsIntoServer } from '../utils/metrics.js';

async function md5Hash(input) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest('MD5', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
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

function isValidUUID(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function isValidName(name) {
  return name && typeof name === 'string' && name.trim().length > 0 && name.length <= 100;
}

function parseTrafficToBytes(value) {
  if (value === null || value === undefined || value === '') return 0;

  const text = String(value).trim();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
  if (!match) return 0;

  const amount = parseFloat(match[1]);
  const unit = (match[2] || 'gb').toLowerCase();
  const multipliers = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4
  };

  return amount * (multipliers[unit] || 1);
}

export async function handleAdminAPI(request, env, sys) {
  try {
    const data = await request.json();

    if (data.action === 'login') {
      const { username, password } = data;
      
      if (!username || !password) {
        return new Response(JSON.stringify({ error: 'Missing username or password' }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const turnstileEnabled = sys && (sys.turnstile_enabled === 'true' || sys.turnstile_enabled === true);
      const turnstileSecretKey = sys && sys.turnstile_secret_key || '';
      
      if (turnstileEnabled) {
        const turnstileToken = request.headers.get('X-Turnstile-Token');
        const isTurnstileVerified = await verifyTurnstileToken(turnstileToken, turnstileSecretKey);
        
        if (!isTurnstileVerified) {
          return new Response(JSON.stringify({ error: 'Turnstile verification failed' }), { 
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      const authHeader = 'Basic ' + btoa(username + ':' + password);
      const mockRequest = {
        headers: {
          get: (key) => key === 'Authorization' ? authHeader : null
        }
      };

      const isValid = await validateCredentials(mockRequest, env, sys);
      
      if (!isValid) {
        return new Response(JSON.stringify({ error: 'Invalid username or password' }), { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      try {
        const token = await generateToken(env, sys);
        return new Response(JSON.stringify({ 
          success: true, 
          token: token,
          message: {
            en: 'Login successful',
            zh: '登录成功'
          }
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (!await checkAuth(request, env, sys)) {
      return simpleAuthResponse();
    }

    if (data.action === 'get_settings') {
      return new Response(JSON.stringify({
        success: true,
        settings: sys,
        api_secret: env.API_SECRET
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    else if (data.action === 'list') {
      const servers = await getAllServers(env.DB);
      const latestMetricsMap = await getLatestMetricsForAllServers(env.DB);
      
      const now = Date.now();
      const ONLINE_THRESHOLD = 300000;
      const stats = {
        total: servers.length,
        online: 0,
        offline: 0,
        total_cpu: 0,
        total_ram: 0,
        total_disk: 0,
        total_net_in: 0,
        total_net_out: 0,
        avg_cpu: 0,
        avg_ram: 0,
        avg_disk: 0
      };
      
      const serversWithStatus = servers.map(server => {
        const latestMetrics = latestMetricsMap.get(server.id);
        const item = { ...server };
        let isOnline = false;
        
        if (latestMetrics) {
          isOnline = (now - latestMetrics.timestamp) < ONLINE_THRESHOLD;
          mergeMetricsIntoServer(item, latestMetrics);
        } else {
          item.last_updated = 0;
          item.is_online = false;
          item.cpu_cores = 0;
          item.cpu_info = '';
          item.arch = '';
          item.os = '';
          item.ip_v4 = '0';
          item.ip_v6 = '0';
          item.boot_time = '';
        }
        
        item.is_online = isOnline;
        if (!item.country) item.country = server.country || '';

        if (isOnline) {
          stats.online++;
          stats.total_cpu += parseFloat(item.cpu) || 0;
          stats.total_ram += parseFloat(item.ram) || 0;
          stats.total_disk += parseFloat(item.disk) || 0;
          stats.total_net_in += parseFloat(item.net_in_speed) || 0;
          stats.total_net_out += parseFloat(item.net_out_speed) || 0;
        } else {
          stats.offline++;
        }
        
        return item;
      });
      
      if (stats.online > 0) {
        stats.avg_cpu = (stats.total_cpu / stats.online).toFixed(2);
        stats.avg_ram = (stats.total_ram / stats.online).toFixed(2);
        stats.avg_disk = (stats.total_disk / stats.online).toFixed(2);
      }

      return new Response(JSON.stringify({
        success: true,
        servers: serversWithStatus,
        stats
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    else if (data.action === 'save_settings') {
      const settings = data.settings || {};

      const APPEARANCE_FIELDS = ['site_title', 'custom_bg', 'custom_head', 'custom_script'];
      const SITE_FIELDS = ['is_public', 'show_price', 'show_expire', 'show_bw', 'show_tf', 'tg_notify', 'tg_bot_token', 'tg_chat_id', 'turnstile_enabled', 'turnstile_site_key', 'turnstile_secret_key', 'jwt_secret', 'username', 'password', 'custom_ct', 'custom_cu', 'custom_cm', 'custom_bd'];

      const appearanceOptions = {};
      for (const field of APPEARANCE_FIELDS) {
        if (settings[field] !== undefined) {
          appearanceOptions[field] = settings[field];
        }
      }
      await env.DB.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).bind('appearance_options', JSON.stringify(appearanceOptions)).run();

      const existingSiteOptionsResult = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('site_options').first();
      const existingSiteOptions = existingSiteOptionsResult && existingSiteOptionsResult.value && existingSiteOptionsResult.value.length > 0 
        ? JSON.parse(existingSiteOptionsResult.value) 
        : {};

      const siteOptions = { ...existingSiteOptions };
      for (const field of SITE_FIELDS) {
        if (settings[field] !== undefined) {
          if (field === 'password') {
            if (settings[field] && settings[field].length > 0) {
              siteOptions[field] = await md5Hash(settings[field]);
            }
          } else {
            siteOptions[field] = settings[field];
          }
        }
      }
      await env.DB.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).bind('site_options', JSON.stringify(siteOptions)).run();

      Object.assign(sys, appearanceOptions, siteOptions);

      if (settings && ('tg_notify' in settings || 'tg_bot_token' in settings || 'tg_chat_id' in settings)) {
        clearNotificationSettingsCache();
      }
      return new Response(JSON.stringify({ 
        success: true, 
        message: {
          en: 'Update Success',
          zh: '更新成功'
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } 
    else if (data.action === 'add') {
      const name = data.name || 'New Server';
      if (!isValidName(name)) {
        return new Response(JSON.stringify({ error: '服务器名称无效' }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const id = crypto.randomUUID();
      const group = data.server_group || 'Default';
      
      const { max_order } = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_order FROM servers').first();
      const sortOrder = (max_order || 0) + 1;
      
      await env.DB.prepare(`
        INSERT INTO servers 
        (id, name, server_group, sort_order) 
        VALUES (?, ?, ?, ?)
      `).bind(id, name, group, sortOrder).run();
      
      clearServersListCache();
      
      return new Response(JSON.stringify({ 
        success: true, 
        id: id,
        message: {
          en: `Server "${name}" added`,
          zh: `服务器 "${name}" 已添加`
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } 
    else if (data.action === 'delete') {
      const { id } = data;
      if (!id || !isValidUUID(id)) {
        return new Response(JSON.stringify({ error: '服务器 ID 无效' }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      await env.DB.prepare('DELETE FROM metrics_history WHERE server_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(id).run();
      
      clearServersListCache();
      clearServerDetailCache(id);
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: {
          en: 'Server deleted',
          zh: '服务器已删除'
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } 
    else if (data.action === 'save_order') {
      const { orders } = data;
      if (!orders || !Array.isArray(orders) || orders.length === 0) {
        return new Response(JSON.stringify({ error: '缺少排序数据' }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      for (let i = 0; i < orders.length; i++) {
        if (!isValidUUID(orders[i])) {
          return new Response(JSON.stringify({ error: '排序数据包含无效 ID' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        await env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(i, orders[i]).run();
      }
      
      clearServersListCache();
      clearServerDetailCache(id);
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: {
          en: 'Sort order saved',
          zh: '排序已保存'
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    else if (data.action === 'edit') {
      const { id, name, server_group, price, expire_date, bandwidth, traffic_limit, traffic_used_baseline, traffic_reset_day, traffic_count_mode, is_hidden } = data;
      if (!id || !isValidUUID(id)) {
        return new Response(JSON.stringify({ error: '服务器 ID 无效' }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const hasBaselineInput = traffic_used_baseline !== undefined && String(traffic_used_baseline).trim() !== '';
      const baselineBytes = hasBaselineInput ? parseTrafficToBytes(traffic_used_baseline) : 0;
      const resetDay = Math.min(31, Math.max(1, parseInt(traffic_reset_day) || 1));
      const countMode = ['sum', 'rx', 'tx'].includes(traffic_count_mode) ? traffic_count_mode : 'sum';
      const latestMetrics = await getLatestMetricsForAllServers(env.DB);
      const currentMetrics = latestMetrics.get(id);
      const currentMonthlyRx = parseFloat(currentMetrics?.net_rx_monthly) || 0;
      const currentMonthlyTx = parseFloat(currentMetrics?.net_tx_monthly) || 0;
      const baselineRx = hasBaselineInput ? currentMonthlyRx : 0;
      const baselineTx = hasBaselineInput ? currentMonthlyTx : 0;

      if (name && typeof name === 'string' && name.trim().length > 0 && name.length <= 100) {
        await env.DB.prepare(`
          UPDATE servers 
          SET name = ?, server_group = ?, price = ?, expire_date = ?, bandwidth = ?, traffic_limit = ?,
              traffic_used_baseline = ?, traffic_rx_baseline = ?, traffic_tx_baseline = ?, traffic_reset_day = ?, traffic_count_mode = ?,
              is_hidden = ? 
          WHERE id = ?
        `).bind(
          name,
          server_group || 'Default', 
          price || '', 
          expire_date || '', 
          bandwidth || '', 
          traffic_limit || '',
          baselineBytes,
          baselineRx,
          baselineTx,
          resetDay,
          countMode,
          is_hidden || '0',
          id
        ).run();
      } else {
        await env.DB.prepare(`
          UPDATE servers 
          SET server_group = ?, price = ?, expire_date = ?, bandwidth = ?, traffic_limit = ?,
              traffic_used_baseline = ?, traffic_rx_baseline = ?, traffic_tx_baseline = ?, traffic_reset_day = ?, traffic_count_mode = ?,
              is_hidden = ? 
          WHERE id = ?
        `).bind(
          server_group || 'Default', 
          price || '', 
          expire_date || '', 
          bandwidth || '', 
          traffic_limit || '',
          baselineBytes,
          baselineRx,
          baselineTx,
          resetDay,
          countMode,
          is_hidden || '0',
          id
        ).run();
      }
      
      clearServersListCache();
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: {
          en: 'Server updated',
          zh: '服务器信息已更新'
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    else if (data.action === 'batch_delete') {
      const { ids } = data;
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return new Response(JSON.stringify({ error: '请选择要删除的服务器' }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      for (const id of ids) {
        if (!isValidUUID(id)) {
          return new Response(JSON.stringify({ error: '包含无效的服务器 ID' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      const placeholders = ids.map(() => '?').join(',');
      await env.DB.prepare(`DELETE FROM metrics_history WHERE server_id IN (${placeholders})`).bind(...ids).run();
      await env.DB.prepare(`DELETE FROM servers WHERE id IN (${placeholders})`).bind(...ids).run();
      
      clearServersListCache();
      for (const id of ids) {
        clearServerDetailCache(id);
      }
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: {
          en: `${ids.length} server(s) deleted`,
          zh: `已删除 ${ids.length} 台服务器`
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ error: '未知操作' }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (e) {
    console.error('Admin API 错误:', e);
    return new Response(JSON.stringify({ error: e.message }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
