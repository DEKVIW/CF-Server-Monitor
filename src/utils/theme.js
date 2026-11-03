const THEME_ASSET_CACHE_TTL_SECONDS = 60 * 60;
const THEME_COMMIT_CACHE_TTL_SECONDS = 24 * 60 * 60;

export function normalizeThemeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return '';
    if (url.username || url.password || url.search || url.hash) return '';

    const parts = url.pathname.split('/').filter(Boolean);
    const ref = parts[3];
    if (
      parts.length < 4 ||
      parts[2] !== 'tree' ||
      !/^[A-Za-z0-9._-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9._-]+$/.test(parts[1]) ||
      !/^[A-Za-z0-9._-]+$/.test(ref) ||
      parts.some(part => part === '.' || part === '..' || /[%\\]/.test(part))
    ) {
      return '';
    }

    return `https://github.com/${parts.join('/')}`;
  } catch (_) {
    return '';
  }
}

export function parseThemeUrl(themeUrl) {
  const normalized = normalizeThemeUrl(themeUrl);
  if (!normalized) return null;

  const url = new URL(normalized);
  const parts = url.pathname.split('/').filter(Boolean);
  const owner = parts[0];
  const repo = parts[1];
  const ref = parts[3];
  const themePathParts = parts.slice(4);
  const encodedThemePath = [owner, repo, ref, ...themePathParts]
    .map(part => encodeURIComponent(part))
    .join('/');

  return {
    themeUrl: normalized,
    ref,
    rawBase: `https://raw.githubusercontent.com/${encodedThemePath}`,
    cacheBase: `https://cfsm-theme-cache.local/${encodedThemePath}`
  };
}

export function getThemeCacheTtl(theme) {
  return /^[a-f0-9]{40}$/i.test(theme?.ref || '')
    ? THEME_COMMIT_CACHE_TTL_SECONDS
    : THEME_ASSET_CACHE_TTL_SECONDS;
}

export function getThemeBrowserCacheControl(theme) {
  return /^[a-f0-9]{40}$/i.test(theme?.ref || '')
    ? 'public, max-age=31536000, immutable'
    : `public, max-age=${THEME_ASSET_CACHE_TTL_SECONDS}`;
}

export function normalizeThemeAssetPath(pathname) {
  const raw = String(pathname || '').slice('/assets/'.length);
  if (!raw) return '';

  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.includes('\\')) return '';
    const parts = decoded.split('/').filter(Boolean);
    if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) return '';
    return parts.map(part => encodeURIComponent(part)).join('/');
  } catch (_) {
    return '';
  }
}

export function getThemeContentType(pathname) {
  const cleanPath = String(pathname || '').split('?')[0].toLowerCase();
  if (cleanPath.endsWith('.html')) return 'text/html;charset=UTF-8';
  if (cleanPath.endsWith('.js') || cleanPath.endsWith('.mjs')) return 'application/javascript;charset=UTF-8';
  if (cleanPath.endsWith('.css')) return 'text/css;charset=UTF-8';
  if (cleanPath.endsWith('.json')) return 'application/json;charset=UTF-8';
  if (cleanPath.endsWith('.svg')) return 'image/svg+xml';
  if (cleanPath.endsWith('.png')) return 'image/png';
  if (cleanPath.endsWith('.jpg') || cleanPath.endsWith('.jpeg')) return 'image/jpeg';
  if (cleanPath.endsWith('.webp')) return 'image/webp';
  if (cleanPath.endsWith('.gif')) return 'image/gif';
  if (cleanPath.endsWith('.ico')) return 'image/x-icon';
  if (cleanPath.endsWith('.avif')) return 'image/avif';
  if (cleanPath.endsWith('.woff')) return 'font/woff';
  if (cleanPath.endsWith('.woff2')) return 'font/woff2';
  if (cleanPath.endsWith('.ttf')) return 'font/ttf';
  if (cleanPath.endsWith('.otf')) return 'font/otf';
  if (cleanPath.endsWith('.map')) return 'application/json;charset=UTF-8';
  return 'application/octet-stream';
}

export function normalizeThemeAssetUrls(html) {
  return html.replace(/\b(src|href)=(['"])\.?\/?assets\//gi, '$1=$2/assets/');
}
