import { http, isAdminLoggedIn } from './http'

const API_BASE = window.location.origin
const WS_PROTO = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const WS_BASE = `${WS_PROTO}//${window.location.host}`

export const createLiveSocket = (subscribe, handlers = {}) => {
  const { onUpdate, onStatus, onMessage } = handlers
  const scope = (subscribe || 'all').toLowerCase()
  let ws = null
  let manualClose = false
  let reconnectTimer = null
  let reconnectDelay = 1000
  let reconnectAttempts = 0
  const MAX_DELAY = 30000
  const MAX_RECONNECT_ATTEMPTS = 10

  const setStatus = (connected, reason) => {
    if (typeof onStatus === 'function') {
      onStatus({ connected, reason: reason || '' })
    }
  }

  const connect = () => {
    manualClose = false
    try {
      ws = new WebSocket(`${WS_BASE}/api/ws?subscribe=${encodeURIComponent(scope)}`)
    } catch (e) {
      setStatus(false, 'WebSocket not supported')
      return
    }

    ws.addEventListener('open', () => {
      reconnectDelay = 1000
      reconnectAttempts = 0
      setStatus(true, 'connected')
    })

    ws.addEventListener('message', (event) => {
      let msg = null
      try {
        msg = typeof event.data === 'string' ? JSON.parse(event.data) : null
      } catch (_) { return }
      if (!msg) return

      if (msg.type === 'update' && typeof onUpdate === 'function') {
        onUpdate({ serverId: msg.serverId, data: msg.data })
      }
      if (typeof onMessage === 'function') onMessage(msg)
    })

    ws.addEventListener('close', () => {
      setStatus(false, 'disconnected')
      scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      setStatus(false, 'error')
      try { ws.close() } catch (_) {}
    })
  }

  const scheduleReconnect = () => {
    if (manualClose) return
    if (reconnectTimer) return
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      setStatus(false, 'max reconnect attempts reached')
      return
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      reconnectAttempts++
      const delay = reconnectDelay
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY)
      setTimeout(connect, delay)
    }, 50)
  }

  connect()

  return {
    close() {
      manualClose = true
      reconnectAttempts = MAX_RECONNECT_ATTEMPTS
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      if (ws) { try { ws.close() } catch (_) {} ws = null }
    },
    reconnect() {
      manualClose = false
      reconnectAttempts = 0
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      if (ws) { try { ws.close() } catch (_) {} ws = null }
      connect()
    }
  }
}

export const formatBytes = (bytes) => {
  bytes = parseFloat(bytes) || 0
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

export const parseTrafficToBytes = (value) => {
  if (value === null || value === undefined || value === '') return 0

  const text = String(value).trim()
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i)
  if (!match) return 0

  const amount = parseFloat(match[1])
  const unit = (match[2] || 'gb').toLowerCase()
  const multipliers = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4
  }

  return amount * (multipliers[unit] || 1)
}

export const getTrafficUsage = (server) => {
  const limitBytes = parseTrafficToBytes(server?.traffic_limit)
  if (!limitBytes) return null

  const monthlyRx = parseFloat(server?.net_rx_monthly) || 0
  const monthlyTx = parseFloat(server?.net_tx_monthly) || 0
  const baseline = parseFloat(server?.traffic_used_baseline) || 0
  const baselineRx = parseFloat(server?.traffic_rx_baseline) || 0
  const baselineTx = parseFloat(server?.traffic_tx_baseline) || 0
  const delta = Math.max(0, monthlyRx - baselineRx) + Math.max(0, monthlyTx - baselineTx)
  const usedBytes = Math.max(0, baseline + delta)
  const percent = limitBytes > 0 ? Math.min((usedBytes / limitBytes) * 100, 999) : 0

  return {
    usedBytes,
    limitBytes,
    percent,
    remainingBytes: Math.max(0, limitBytes - usedBytes)
  }
}

export const fetchServers = async () => {
  const result = await http.get('/api/servers')
  if (result.error) return null
  return result.data
}

export const fetchServerDetail = async (id) => {
  const result = await http.get(`/api/server?id=${id}`)
  if (result.error) return null
  return result.data
}

export const fetchAllHistory = async (id, hours) => {
  const result = await http.get(`/api/history/all?id=${id}&hours=${hours}`)
  if (result.error) return null
  return result.data
}

export const adminApi = async (data) => {
  const headers = {
    'Content-Type': 'application/json'
  }
  const token = localStorage.getItem('jwt_token')
  if (token) {
    headers['Authorization'] = 'Bearer ' + token
  }
  const turnstileToken = localStorage.getItem('turnstile_token')
  if (turnstileToken) {
    headers['X-Turnstile-Token'] = turnstileToken
  }

  const res = await fetch(`${API_BASE}/admin/api`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data)
  })

  if (res.status === 401) {
    localStorage.removeItem('jwt_token')
    window.location.href = '/admin'
  }

  return res
}

export const login = async (username, password, turnstileToken = '') => {
  const headers = {
    'Content-Type': 'application/json'
  }
  if (turnstileToken) {
    headers['X-Turnstile-Token'] = turnstileToken
  }
  
  const res = await fetch(`${API_BASE}/admin/api`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'login', username, password })
  })
  
  if (res.ok) {
    const data = await res.json()
    if (data.token) {
      localStorage.setItem('jwt_token', data.token)
    }
  }
  return res
}

export const logout = () => {
  localStorage.removeItem('jwt_token')
}

export const fetchConfig = async () => {
  const result = await http.get('/api/config', { includeAuth: false, includeTurnstile: false })
  if (result.error) return null
  return result.data
}

export const upgradeDatabase = async () => {
  const result = await http.get('/updateDatabase')
  if (result.error) {
    if (result.status === 401) {
      return { success: false, error: 'Unauthorized' }
    }
    return { success: false, error: 'Request failed' }
  }
  return result.data
}

export const rebuildDatabase = async () => {
  const result = await http.get('/rebuild')
  if (result.error) {
    if (result.status === 401) {
      return { success: false, error: 'Unauthorized' }
    }
    return { success: false, error: 'Request failed' }
  }
  return result.data
}

export { isAdminLoggedIn }
