import { 
  getAllServers, 
  getLatestMetricsCache, 
  setLatestMetricsCache,
  getMetricsHistoryCache,
  setMetricsHistoryCache
} from '../utils/cache.js';
import {
  DASHBOARD_LATENCY_WINDOW_BATCH_SIZE,
  DASHBOARD_LATENCY_WINDOW_CACHE_MAX_SERVERS,
  DASHBOARD_LATENCY_WINDOW_CACHE_TTL_MS,
  DASHBOARD_LATENCY_WINDOW_HOURS,
  DASHBOARD_LATENCY_WINDOW_POINTS
} from '../utils/config.js';

let dbInitialized = false;

const DASHBOARD_LATENCY_FIELDS = ['ct', 'cu', 'cm', 'bd'];
const DASHBOARD_LATENCY_COLUMNS = DASHBOARD_LATENCY_FIELDS.flatMap(field => [
  `ping_${field}`,
  `loss_${field}`
]);
const dashboardLatencyHistoryCache = new Map();

function pruneDashboardLatencyHistoryCache(now = Date.now()) {
  for (const [serverId, entry] of dashboardLatencyHistoryCache) {
    if (!entry || now - entry.cachedAt > DASHBOARD_LATENCY_WINDOW_CACHE_TTL_MS) {
      dashboardLatencyHistoryCache.delete(serverId);
    }
  }

  while (dashboardLatencyHistoryCache.size > DASHBOARD_LATENCY_WINDOW_CACHE_MAX_SERVERS) {
    const oldestServerId = dashboardLatencyHistoryCache.keys().next().value;
    if (oldestServerId === undefined) break;
    dashboardLatencyHistoryCache.delete(oldestServerId);
  }
}

export function clearDashboardLatencyHistoryCache(serverId = null) {
  if (serverId == null) {
    dashboardLatencyHistoryCache.clear();
  } else {
    dashboardLatencyHistoryCache.delete(String(serverId));
  }
}

function getCacheDuration(hours) {
  if (hours >= 60) {
    return 5 * 60 * 1000;
  } else if (hours >= 30) {
    return 3 * 60 * 1000;
  } else {
    return 1 * 60 * 1000;
  }
}

export async function initDatabase(db) {
  if (dbInitialized) return;
  
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, 
        value TEXT
      )
    `).run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT,
        server_group TEXT DEFAULT 'Default',
        price TEXT DEFAULT '',
        expire_date TEXT DEFAULT '',
        bandwidth TEXT DEFAULT '',
        traffic_limit TEXT DEFAULT '',
        report_interval INTEGER DEFAULT 60,
        ping_mode TEXT DEFAULT 'http',
        traffic_used_baseline REAL DEFAULT 0,
        traffic_rx_baseline REAL DEFAULT 0,
        traffic_tx_baseline REAL DEFAULT 0,
        traffic_baseline_period_start REAL DEFAULT 0,
        traffic_reset_day INTEGER DEFAULT 1,
        traffic_reset_tz INTEGER DEFAULT 8,
        traffic_count_mode TEXT DEFAULT 'sum',
        traffic_iface TEXT DEFAULT '',
        is_hidden TEXT DEFAULT '0',
        sort_order INTEGER DEFAULT 0
      )
    `).run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS metrics_history (
        id INTEGER PRIMARY KEY,
        server_id TEXT NOT NULL,
        timestamp INTEGER DEFAULT 0,
        cpu REAL DEFAULT 0,
        ram REAL DEFAULT 0,
        disk REAL DEFAULT 0,
        load_avg TEXT DEFAULT '0',
        net_in_speed REAL DEFAULT 0,
        net_out_speed REAL DEFAULT 0,
        net_rx REAL DEFAULT 0,
        net_tx REAL DEFAULT 0,
        processes INTEGER DEFAULT 0,
        tcp_conn INTEGER DEFAULT 0,
        udp_conn INTEGER DEFAULT 0,
        ping_ct INTEGER DEFAULT 0,
        ping_cu INTEGER DEFAULT 0,
        ping_cm INTEGER DEFAULT 0,
        ping_bd INTEGER DEFAULT 0,
        loss_ct INTEGER DEFAULT NULL,
        loss_cu INTEGER DEFAULT NULL,
        loss_cm INTEGER DEFAULT NULL,
        loss_bd INTEGER DEFAULT NULL,
        ram_total REAL DEFAULT 0,
        ram_used REAL DEFAULT 0,
        swap_total REAL DEFAULT 0,
        swap_used REAL DEFAULT 0,
        disk_total REAL DEFAULT 0,
        disk_used REAL DEFAULT 0,
        cpu_cores INTEGER DEFAULT 0,
        cpu_info TEXT DEFAULT '',
        arch TEXT DEFAULT '',
        os TEXT DEFAULT '',
        country TEXT DEFAULT '',
        ip_v4 TEXT DEFAULT '0',
        ip_v6 TEXT DEFAULT '0',
        boot_time TEXT DEFAULT '',
        net_rx_monthly REAL DEFAULT 0,
        net_tx_monthly REAL DEFAULT 0,
        traffic_period_start REAL DEFAULT 0,
        FOREIGN KEY (server_id) REFERENCES servers(id)
      )
    `).run();

    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_history_server_time 
      ON metrics_history(server_id, timestamp)
    `).run();

    console.log('✅ 数据库初始化完成');
    dbInitialized = true;
  } catch (e) {
    console.error('❌ 数据库初始化失败:', e);
  }
}

export async function rebuildDatabase(db) {
  console.log('开始执行数据库重建...');
  
  try {
    await db.prepare(`DROP TABLE IF EXISTS metrics_history`).run();
    console.log('✅ 已删除 metrics_history 表');
    
    await db.prepare(`DROP TABLE IF EXISTS servers`).run();
    console.log('✅ 已删除 servers 表');
    
    await db.prepare(`DROP TABLE IF EXISTS settings`).run();
    console.log('✅ 已删除 settings 表');
    
    dbInitialized = false;
    
    await initDatabase(db);
    
    console.log('✅ 数据库重建完成');
    
    return {
      success: true,
      message: {
        en: 'Database rebuilt successfully',
        zh: '数据库重建成功'
      }
    };
  } catch (e) {
    console.error('❌ 数据库重建失败:', e);
    return {
      success: false,
      message: {
        en: 'Database rebuild failed',
        zh: '数据库重建失败'
      },
      error: e.message
    };
  }
}

export async function getMetricsHistory(db, serverId, hours, columns) {
  const now = Date.now();
  const cacheDuration = getCacheDuration(hours);
  
  const cached = getMetricsHistoryCache(serverId, hours, columns);
  if (cached && now - cached.timestamp < cacheDuration) {
    console.log(`[History] CACHE HIT: ${serverId}, hours: ${hours}`);
    return cached.data;
  }
  
  let queryHours = hours;
  let intervalMs;
  
  if (hours > 72) {
    queryHours = 72;
    intervalMs = 25 * 60 * 1000;
  } else if (hours >= 24) {
    intervalMs = 15 * 60 * 1000;
  } else if (hours >= 12) {
    intervalMs = 10 * 60 * 1000;
  } else if (hours >= 6) {
    intervalMs = 5 * 60 * 1000;
  } else if (hours > 1) {
    intervalMs = 1 * 60 * 1000;
  } else {
    intervalMs = 10 * 1000;
  }

  const cutoff = now - queryHours * 60 * 60 * 1000;

  console.log(
    '[History]',
    'server:', serverId,
    'hours:', hours,
    'queryHours:', queryHours,
    'interval:', intervalMs,
    'cutoff:', new Date(cutoff).toISOString()
  );

  const queryHistory = selectedColumns => db.prepare(`
    WITH sampled AS (
      SELECT
        timestamp,
        ${selectedColumns},
        ROW_NUMBER() OVER (
          PARTITION BY CAST(timestamp / ? AS INTEGER)
          ORDER BY timestamp
        ) AS rn
      FROM metrics_history
      WHERE server_id = ?
        AND typeof(timestamp) = 'integer'
        AND timestamp >= ?
    )
    SELECT timestamp, ${selectedColumns}
    FROM sampled
    WHERE rn = 1
  `).bind(intervalMs, serverId, cutoff).all();

  let rawResult;
  try {
    rawResult = await queryHistory(columns);
  } catch (error) {
    if (!/no column named loss_/i.test(error?.message || '')) throw error;
    const legacyColumns = columns
      .split(',')
      .map(column => column.trim())
      .filter(column => !column.startsWith('loss_'))
      .join(', ');
    console.warn('metrics_history 尚未升级 loss_* 字段，历史查询暂按旧结构返回');
    rawResult = await queryHistory(legacyColumns);
  }

  const result = rawResult.results.map(row => ({
    ...row,
    timestamp: Number(row.timestamp)
  }));

  result.sort((a, b) => a.timestamp - b.timestamp);
  
  setMetricsHistoryCache(serverId, hours, columns, result);

  console.log(`[History] FINAL: ${result.length}`);

  return result;
}

function normalizeDashboardLatencyValue(value) {
  if (value === null || value === undefined || value === '' || String(value).toLowerCase() === 'false') {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function normalizeDashboardLossValue(value) {
  if (value === null || value === undefined || value === '' || String(value).toLowerCase() === 'false') {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

function buildDashboardLatencyWindow(rows, queryStart, intervalMs, points) {
  const buckets = Array.from({ length: points }, () => null);

  const hasPingValue = row => DASHBOARD_LATENCY_FIELDS.some(field =>
    normalizeDashboardLatencyValue(row?.[`ping_${field}`]) !== null ||
    normalizeDashboardLossValue(row?.[`loss_${field}`]) !== null
  );

  for (const row of rows || []) {
    const timestamp = Number(row?.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < queryStart) continue;

    const bucket = Math.floor((timestamp - queryStart) / intervalMs);
    if (bucket < 0 || bucket >= points) continue;

    // 每个槽内可能有多条上报。优先保留有真实 Ping 的行，避免槽内第一条
    // 恰好是空值而把后续有效采样错误显示成灰色。
    if (!buckets[bucket] || (!hasPingValue(buckets[bucket]) && hasPingValue(row))) {
      buckets[bucket] = row;
    }
  }

  const ping = buckets.map((row, index) => {
    const point = { ts: queryStart + index * intervalMs };
    for (const field of DASHBOARD_LATENCY_FIELDS) {
      point[field] = normalizeDashboardLatencyValue(row?.[`ping_${field}`]);
    }
    return point;
  });

  const loss = buckets.map((row, index) => {
    const point = { ts: queryStart + index * intervalMs };
    for (const field of DASHBOARD_LATENCY_FIELDS) {
      point[field] = normalizeDashboardLossValue(row?.[`loss_${field}`]);
    }
    return point;
  });

  return { ping, loss };
}

/**
 * 为第三方主题提供首页最近两小时的真实 Ping 历史。
 *
 * 这是首屏补数接口，不参与 WebSocket 实时刷新。没有历史行时返回空窗口，
 * 主题会继续使用当前值逐步累积，避免用上一值伪造历史。
 */
export async function getDashboardLatencyHistory(db, servers, options = {}) {
  const serverList = Array.isArray(servers) ? servers : [];
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const points = Number.isInteger(options.points) && options.points > 0
    ? options.points
    : DASHBOARD_LATENCY_WINDOW_POINTS;
  const queryStart = now - DASHBOARD_LATENCY_WINDOW_HOURS * 60 * 60 * 1000;
  const queryEnd = now + 1000;
  const intervalMs = Math.max(10_000, Math.ceil((queryEnd - queryStart) / points));
  const result = new Map();
  const pending = [];

  pruneDashboardLatencyHistoryCache(now);

  for (const server of serverList) {
    const serverId = String(server?.id || '').trim();
    if (!serverId) continue;

    const cached = dashboardLatencyHistoryCache.get(serverId);
    if (cached && now - cached.cachedAt < DASHBOARD_LATENCY_WINDOW_CACHE_TTL_MS) {
      result.set(serverId, cached.window);
      continue;
    }

    pending.push({ serverId });
  }

  if (pending.length === 0) return result;

  const columns = ['timestamp', ...DASHBOARD_LATENCY_COLUMNS].join(', ');
  const query = `
    SELECT ${columns}
    FROM metrics_history
    WHERE server_id = ?
      AND typeof(timestamp) = 'integer'
      AND timestamp >= ?
      AND timestamp < ?
    ORDER BY timestamp ASC
  `;
  const legacyColumns = ['timestamp', ...DASHBOARD_LATENCY_FIELDS.map(field => `ping_${field}`)].join(', ');
  const legacyQuery = `
    SELECT ${legacyColumns}
    FROM metrics_history
    WHERE server_id = ?
      AND typeof(timestamp) = 'integer'
      AND timestamp >= ?
      AND timestamp < ?
    ORDER BY timestamp ASC
  `;

  const queryRows = async serverId => {
    try {
      return await db.prepare(query).bind(serverId, queryStart, queryEnd).all();
    } catch (error) {
      if (!/no column named loss_/i.test(error?.message || '')) throw error;
      return db.prepare(legacyQuery).bind(serverId, queryStart, queryEnd).all();
    }
  };

  const applyRows = (serverId, rows) => {
    if (!Array.isArray(rows) || rows.length === 0) {
      applyEmpty(serverId);
      return;
    }
    const window = buildDashboardLatencyWindow(rows, queryStart, intervalMs, points);
    result.set(serverId, window);
    dashboardLatencyHistoryCache.set(serverId, { cachedAt: now, window });
  };

  const applyEmpty = serverId => {
    const empty = { ping: [], loss: [] };
    result.set(serverId, empty);
    dashboardLatencyHistoryCache.set(serverId, { cachedAt: now, window: empty });
  };

  for (let offset = 0; offset < pending.length; offset += DASHBOARD_LATENCY_WINDOW_BATCH_SIZE) {
    const chunk = pending.slice(offset, offset + DASHBOARD_LATENCY_WINDOW_BATCH_SIZE);
    if (typeof db.batch !== 'function') {
      await Promise.all(chunk.map(async ({ serverId }) => {
        try {
          const response = await queryRows(serverId);
          applyRows(serverId, response?.results);
        } catch (error) {
          console.warn('[DashboardLatency] query failed:', serverId, error?.message || error);
          applyEmpty(serverId);
        }
      }));
      continue;
    }

    try {
      const responses = await db.batch(chunk.map(({ serverId }) =>
        db.prepare(query).bind(serverId, queryStart, queryEnd)
      ));

      for (let index = 0; index < chunk.length; index += 1) {
        const serverId = chunk[index].serverId;
        const rows = responses?.[index]?.results;
        if (Array.isArray(rows)) applyRows(serverId, rows);
        else applyEmpty(serverId);
      }
    } catch (error) {
      // 批量查询失败时逐台降级，单台历史异常不能影响整个首页。
      console.warn('[DashboardLatency] batch query failed, falling back:', error?.message || error);
      await Promise.all(chunk.map(async ({ serverId }) => {
        try {
          const response = await queryRows(serverId);
          applyRows(serverId, response?.results);
        } catch (fallbackError) {
          console.warn('[DashboardLatency] fallback query failed:', serverId, fallbackError?.message || fallbackError);
          applyEmpty(serverId);
        }
      }));
    }
  }

  return result;
}

export async function cleanupOldData(db) {
  try {
    const now = Date.now();
    const cleanupInterval = 1 * 24 * 60 * 60 * 1000;
    
    const stats = {
      expired: 0,
      deleted: 0
    };
    
    const rawCutoff = now - cleanupInterval;
    const intDeleteResult = await db.prepare(
      `DELETE FROM metrics_history WHERE typeof(timestamp) = 'integer' AND timestamp < ?`
    ).bind(rawCutoff).run();
    stats.expired = intDeleteResult.meta.changes || 0;
    stats.deleted += stats.expired;
    
    const totalDeleted = stats.deleted;
    
    if (totalDeleted > 0) {
      console.log(`[Cleanup] 清理 ${totalDeleted} 条过期数据`);
    }
    
    return {
      success: true,
      deleted: totalDeleted,
      expired: stats.expired
    };
  } catch (e) {
    console.error('[Cleanup] 清理数据失败:', e);
    return { success: false, error: e.message };
  }
}

export async function saveMetricsHistory(db, serverId, metrics, countryCode = '') {
  try {
    const now = Date.now();
    
    const parsePing = (val) => {
      if (val === '' || val === null || val === undefined) return null;
      const num = parseInt(val);
      return (num > 0) ? num : null;
    };

    const parseLoss = (val) => {
      if (val === '' || val === null || val === undefined || String(val).toLowerCase() === 'false') {
        return null;
      }
      const num = Number(val);
      return Number.isFinite(num) && num >= 0 && num <= 100 ? num : null;
    };
    
    const baseColumns = [
      'server_id', 'timestamp', 'cpu', 'ram', 'disk', 'load_avg',
      'net_in_speed', 'net_out_speed', 'net_rx', 'net_tx',
      'processes', 'tcp_conn', 'udp_conn',
      'ping_ct', 'ping_cu', 'ping_cm', 'ping_bd'
    ];
    const lossColumns = ['loss_ct', 'loss_cu', 'loss_cm', 'loss_bd'];
    const tailColumns = [
      'ram_total', 'ram_used', 'swap_total', 'swap_used',
      'disk_total', 'disk_used',
      'cpu_cores', 'cpu_info', 'arch', 'os', 'country', 'ip_v4', 'ip_v6', 'boot_time',
      'net_rx_monthly', 'net_tx_monthly', 'traffic_period_start'
    ];
    const baseValues = [
      serverId,
      now,
      parseFloat(metrics.cpu) || 0,
      parseFloat(metrics.ram) || 0,
      parseFloat(metrics.disk) || 0,
      metrics.load || metrics.load_avg || '0 0 0',
      parseFloat(metrics.net_in_speed) || 0,
      parseFloat(metrics.net_out_speed) || 0,
      parseFloat(metrics.net_rx) || 0,
      parseFloat(metrics.net_tx) || 0,
      parseInt(metrics.processes) || 0,
      parseInt(metrics.tcp_conn) || 0,
      parseInt(metrics.udp_conn) || 0,
      parsePing(metrics.ping_ct),
      parsePing(metrics.ping_cu),
      parsePing(metrics.ping_cm),
      parsePing(metrics.ping_bd),
    ];
    const lossValues = [
      parseLoss(metrics.loss_ct),
      parseLoss(metrics.loss_cu),
      parseLoss(metrics.loss_cm),
      parseLoss(metrics.loss_bd),
    ];
    const tailValues = [
      parseFloat(metrics.ram_total) || 0,
      parseFloat(metrics.ram_used) || 0,
      parseFloat(metrics.swap_total) || 0,
      parseFloat(metrics.swap_used) || 0,
      parseFloat(metrics.disk_total) || 0,
      parseFloat(metrics.disk_used) || 0,
      parseInt(metrics.cpu_cores) || 0,
      metrics.cpu_info || '',
      metrics.arch || '',
      metrics.os || '',
      countryCode,
      metrics.ip_v4 || '0',
      metrics.ip_v6 || '0',
      metrics.boot_time || '',
      parseFloat(metrics.net_rx_monthly) || 0,
      parseFloat(metrics.net_tx_monthly) || 0,
      parseFloat(metrics.traffic_period_start) || 0
    ];

    const insertHistoryRow = async includeLoss => {
      const columns = includeLoss
        ? [...baseColumns, ...lossColumns, ...tailColumns]
        : [...baseColumns, ...tailColumns];
      const values = includeLoss
        ? [...baseValues, ...lossValues, ...tailValues]
        : [...baseValues, ...tailValues];
      await db.prepare(`
        INSERT INTO metrics_history (${columns.join(', ')})
        VALUES (${columns.map(() => '?').join(', ')})
      `).bind(...values).run();
    };

    try {
      await insertHistoryRow(true);
    } catch (error) {
      if (!/no column named loss_/i.test(error?.message || '')) throw error;
      console.warn('metrics_history 尚未升级 loss_* 字段，暂按旧结构保存本次指标');
      await insertHistoryRow(false);
    }
  } catch (e) {
    console.error('保存历史数据失败:', e);
  }
}

export async function getLatestMetrics(db, serverId) {
  try {
    const result = await db.prepare(`
      SELECT * FROM metrics_history 
      WHERE server_id = ? 
      ORDER BY timestamp DESC 
      LIMIT 1
    `).bind(serverId).first();
    
    return result || null;
  } catch (e) {
    console.error('获取最新指标数据失败:', e);
    return null;
  }
}

export async function getLatestMetricsForAllServers(db) {
  const now = Date.now();
  const cacheInfo = getLatestMetricsCache();
  if (cacheInfo.cache && now - cacheInfo.time < cacheInfo.ttl) {
    return cacheInfo.cache;
  }

  try {
    const servers = await getAllServers(db);

    const entries = await Promise.all(
      servers.map(s =>
        getLatestMetrics(db, s.id).then(metrics => [s.id, metrics])
      )
    );

    const result = new Map(entries.filter(([, m]) => m !== null));
    setLatestMetricsCache(result);
    return result;
  } catch (e) {
    console.error('获取所有服务器最新指标数据失败:', e);
    const cacheInfo = getLatestMetricsCache();
    return cacheInfo.cache || new Map();
  }
}

export { getAllServers };
