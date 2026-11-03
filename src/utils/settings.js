const APPEARANCE_FIELDS = ['site_title', 'custom_bg', 'custom_head', 'custom_script', 'theme_options'];
const SITE_FIELDS = ['is_public', 'show_price', 'show_expire', 'show_bw', 'show_tf', 'tg_notify', 'tg_bot_token', 'tg_chat_id', 'turnstile_enabled', 'turnstile_site_key', 'turnstile_secret_key', 'jwt_secret', 'username', 'password', 'custom_ct', 'custom_cu', 'custom_cm', 'custom_bd', 'theme_url'];

const defaults = {
  site_title: 'Cloudflare Server Monitor',
  custom_bg: '',
  custom_head: '',
  custom_script: '',
  theme_options: {},
  is_public: 'true',
  show_price: 'true',
  show_expire: 'true',
  show_bw: 'true',
  show_tf: 'true',
  tg_notify: 'false',
  tg_bot_token: '',
  tg_chat_id: '',
  turnstile_enabled: 'false',
  turnstile_site_key: '',
  turnstile_secret_key: '',
  custom_ct: 'gd-ct-dualstack.ip.zstaticcdn.com',
  custom_cu: 'gd-cu-dualstack.ip.zstaticcdn.com',
  custom_cm: 'gd-cm-dualstack.ip.zstaticcdn.com',
  custom_bd: 'lf3-ips.zstaticcdn.com',
  theme_url: ''
};

function tryParseJSON(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}

export async function loadSiteSettings(db) {
  const result = { ...defaults };
  let hasSite = false;

  try {
    const siteRow = await db.prepare(
      "SELECT value FROM settings WHERE key = 'site_options'"
    ).first();
    if (siteRow) {
      const parsed = tryParseJSON(siteRow.value);
      if (parsed) {
        hasSite = true;
        for (const field of SITE_FIELDS) {
          if (parsed[field] !== undefined) {
            result[field] = parsed[field];
          }
        }
      }
    }

    if (!hasSite) {
      const { results } = await db.prepare('SELECT * FROM settings').all();
      if (results && results.length > 0) {
        results.forEach(r => {
          if (SITE_FIELDS.includes(r.key)) {
            result[r.key] = r.value;
          }
        });
      }
    }
  } catch (e) {
    console.error('加载站点设置失败:', e);
  }

  return result;
}

export async function loadSettings(db) {
  const result = { ...defaults };
  let hasAppearance = false;
  let hasSite = false;

  try {
    const appearanceRow = await db.prepare(
      "SELECT value FROM settings WHERE key = 'appearance_options'"
    ).first();
    if (appearanceRow) {
      const parsed = tryParseJSON(appearanceRow.value);
      if (parsed) {
        hasAppearance = true;
        for (const field of APPEARANCE_FIELDS) {
          if (parsed[field] !== undefined) {
            result[field] = parsed[field];
          }
        }
      }
    }

    const siteRow = await db.prepare(
      "SELECT value FROM settings WHERE key = 'site_options'"
    ).first();
    if (siteRow) {
      const parsed = tryParseJSON(siteRow.value);
      if (parsed) {
        hasSite = true;
        for (const field of SITE_FIELDS) {
          if (parsed[field] !== undefined) {
            result[field] = parsed[field];
          }
        }
      }
    }

    if (!hasAppearance || !hasSite) {
      const { results } = await db.prepare('SELECT * FROM settings').all();
      if (results && results.length > 0) {
        results.forEach(r => {
          if (!hasAppearance && APPEARANCE_FIELDS.includes(r.key)) {
            result[r.key] = r.value;
          }
          if (!hasSite && SITE_FIELDS.includes(r.key)) {
            result[r.key] = r.value;
          }
        });
      }
    }
  } catch (e) {
    console.error('加载设置失败:', e);
  }

  return result;
}

export function isValidThemeOptions(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function saveThemeOptions(db, themeOptions) {
  const row = await db.prepare(
    "SELECT value FROM settings WHERE key = 'appearance_options'"
  ).first();
  let existing = {};

  if (row?.value) {
    const parsed = tryParseJSON(row.value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed;
    }
  }

  const next = { ...existing, theme_options: themeOptions };
  const appearanceOptions = {};
  for (const field of APPEARANCE_FIELDS) {
    if (field in next) appearanceOptions[field] = next[field];
  }

  await db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind('appearance_options', JSON.stringify(appearanceOptions)).run();

  return themeOptions;
}
