import { loadSettings } from '../utils/settings.js';
import {
  getThemeBrowserCacheControl,
  getThemeCacheTtl,
  getThemeContentType,
  normalizeThemeAssetPath,
  normalizeThemeAssetUrls,
  normalizeThemeUrl,
  parseThemeUrl
} from '../utils/theme.js';

const MAX_THEME_INDEX_BYTES = 512 * 1024;
let filesCache = null;

async function loadFrontendFiles(env) {
  if (filesCache) return filesCache;

  try {
    const files = {};

    if (env.ASSETS) {
      try {
        const response = await env.ASSETS.fetch(new Request('http://static/dashboard.html'));
        if (response.ok) {
          files['dashboard.html'] = await response.text();
        }
      } catch (_) {
        console.log('[INFO] No readable ASSETS binding');
      }
    }

    filesCache = files;
    return filesCache;
  } catch (e) {
    console.error('[ERROR] Failed to load frontend files:', e);
    return {};
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeCssString(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function insertBeforeHeadClose(html, content) {
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${content}\n</head>`);
  }
  return `${content}\n${html}`;
}

function injectAppearanceSettings(html, settings) {
  let modifiedHtml = html;
  const siteTitle = escapeHtml(settings.site_title || 'Server Monitor');

  if (/<title>.*?<\/title>/is.test(modifiedHtml)) {
    modifiedHtml = modifiedHtml.replace(/<title>.*?<\/title>/is, `<title>${siteTitle}</title>`);
  } else {
    modifiedHtml = insertBeforeHeadClose(modifiedHtml, `<title>${siteTitle}</title>`);
  }

  if (settings.custom_head) {
    modifiedHtml = insertBeforeHeadClose(modifiedHtml, settings.custom_head);
  }

  if (settings.custom_script) {
    if (/<\/body>/i.test(modifiedHtml)) {
      modifiedHtml = modifiedHtml.replace(/<\/body>/i, `<script>${settings.custom_script}</script>\n</body>`);
    } else {
      modifiedHtml += `\n<script>${settings.custom_script}</script>`;
    }
  }

  if (settings.custom_bg) {
    const safeBg = escapeCssString(settings.custom_bg);
    const bgStyle = `<style>body{background-image:url('${safeBg}');background-size:cover;background-attachment:fixed;background-position:center;}</style>`;
    modifiedHtml = insertBeforeHeadClose(modifiedHtml, bgStyle);
  }

  return modifiedHtml;
}

function buildHtmlResponse(html, settings) {
  const rendered = injectAppearanceSettings(html, settings);
  return new Response(rendered, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'CDN-Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function notFoundResponse() {
  return new Response('Not Found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'X-CFSM-Theme-Asset': '1'
    }
  });
}

async function fetchThemeFile(rawUrl, contentType, cacheUrl, cacheTtl) {
  const cacheKey = new Request(cacheUrl || rawUrl, { method: 'GET' });
  const cache = typeof caches !== 'undefined' ? caches.default : null;

  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  let originResponse;
  try {
    originResponse = await fetch(rawUrl, {
      headers: { 'User-Agent': 'CF-Server-Monitor-Theme-Proxy' }
    });
  } catch (e) {
    console.error('[Theme] Remote fetch failed:', e.message);
    return new Response('Theme file unavailable', { status: 502 });
  }

  if (!originResponse.ok) {
    return new Response('Theme file not found', { status: originResponse.status });
  }

  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': `public, max-age=${cacheTtl}`,
    'CDN-Cache-Control': `public, max-age=${cacheTtl}`,
    'X-Content-Type-Options': 'nosniff'
  });
  const etag = originResponse.headers.get('ETag');
  if (etag) headers.set('ETag', etag);

  const response = new Response(originResponse.body, {
    status: 200,
    headers
  });

  if (cache) {
    await cache.put(cacheKey, response.clone()).catch(() => {});
  }

  return response;
}

async function loadThemeIndex(themeUrl) {
  const parsedTheme = parseThemeUrl(themeUrl);
  if (!parsedTheme) return null;

  const response = await fetchThemeFile(
    `${parsedTheme.rawBase}/index.html`,
    'text/html;charset=UTF-8',
    `${parsedTheme.cacheBase}/index.html`,
    getThemeCacheTtl(parsedTheme)
  );

  if (!response.ok) return null;
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_THEME_INDEX_BYTES) {
    console.error('[Theme] index.html is too large');
    return null;
  }

  const html = await response.text();
  if (new TextEncoder().encode(html).byteLength > MAX_THEME_INDEX_BYTES) {
    console.error('[Theme] index.html is too large');
    return null;
  }

  return normalizeThemeAssetUrls(html);
}

async function serveThemeAsset(request, themeUrl) {
  const parsedTheme = parseThemeUrl(themeUrl);
  const url = new URL(request.url);
  const assetPath = normalizeThemeAssetPath(url.pathname);

  if (!parsedTheme || !assetPath) return notFoundResponse();

  const response = await fetchThemeFile(
    `${parsedTheme.rawBase}/assets/${assetPath}`,
    getThemeContentType(assetPath),
    `${parsedTheme.cacheBase}/assets/${assetPath}`,
    getThemeCacheTtl(parsedTheme)
  );
  const headers = new Headers(response.headers);
  headers.set('X-CFSM-Theme-Asset', '1');
  if (response.ok) {
    headers.set('Cache-Control', getThemeBrowserCacheControl(parsedTheme));
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function shouldUseBuiltinFrontend(path) {
  return path === '/admin' || path.startsWith('/admin/');
}

export async function serveFrontend(request, env, settings = null) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!settings) {
    settings = await loadSettings(env.DB);
  }

  const configuredThemeUrl = normalizeThemeUrl(settings?.theme_url);

  if (request.method === 'GET' && path.startsWith('/assets/') && configuredThemeUrl) {
    return serveThemeAsset(request, configuredThemeUrl);
  }

  if (!shouldUseBuiltinFrontend(path) && configuredThemeUrl) {
    try {
      const themeHtml = await loadThemeIndex(configuredThemeUrl);
      if (themeHtml) return buildHtmlResponse(themeHtml, settings);
      console.error('[Theme] Theme index unavailable, falling back to built-in frontend');
    } catch (e) {
      console.error('[Theme] Theme loading failed, falling back to built-in frontend:', e.message);
    }
  }

  const files = await loadFrontendFiles(env);
  const html = files['dashboard.html'];
  if (html) return buildHtmlResponse(html, settings);

  return new Response('Frontend not available. Please build the frontend first with `npm run build:frontend`.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
  });
}
