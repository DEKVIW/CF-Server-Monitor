// 首页主题需要的轻量延迟窗口口径。
// 这只影响 /api/servers 首屏数据，不改变探针上报或详情页历史查询。
export const DASHBOARD_LATENCY_WINDOW_POINTS = 20;
export const DASHBOARD_LATENCY_WINDOW_HOURS = 2;
export const DASHBOARD_LATENCY_WINDOW_CACHE_TTL_MS = 5 * 60 * 1000;
export const DASHBOARD_LATENCY_WINDOW_CACHE_MAX_SERVERS = 1000;
export const DASHBOARD_LATENCY_WINDOW_BATCH_SIZE = 20;
