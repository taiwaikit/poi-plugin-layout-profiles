/*
 * poi-plugin-layout-profiles — 布局方案存储与应用核心
 *
 * 设计要点（均来自 poi 12.0.1 本体源码，非猜测）：
 *  1. 布局/缩放全部是 poi 的 config 键，poi 自己在 views/services/layout.js 里
 *     监听 `config.set` 并即时重排；插件只要 config.set 就会被 poi 消化，
 *     不需要 reload、不需要私有 API。
 *  2. `poi.appearance.zoom` 分支会先 setContentSize(w-10,h-10)，1 秒后再
 *     setContentSize(w,h) —— 所以切换方案后必须在 1.2s 左右再校正一次窗口尺寸，
 *     否则会被这次"恢复"覆盖成旧尺寸。
 *  3. `poi.layout.overlay` 为真时 poi 会 setResizable(false) + setAspectRatio，
 *     直接 setBounds 会被宽高比约束；切换前必须解除。
 *  4. poi 的窗口尺寸自身会写回 `poi.window`（lib/window.js），所以应用方案后
 *     下次启动仍然是我们设定的样子。
 */
import { join } from 'path'
import { existsSync, renameSync, writeFileSync } from 'fs'
import { ensureDirSync, readJsonSync, writeJsonSync } from 'fs-extra'
import { APPDATA_PATH } from 'views/env'
import { getRemote, getScreen, getWindow, isAlive } from './remote.es'

const STORE_DIR = join(APPDATA_PATH, 'layout-profiles')

const STORE_FILE = join(STORE_DIR, 'profiles.json')
const STORE_TMP = join(STORE_DIR, 'profiles.json.tmp')
const STORE_BROKEN = join(STORE_DIR, 'profiles.broken.json')

/** 参与快照的全部 config 键（顺序即写入顺序，顺序敏感） */
export const CONFIG_KEYS = [
  'poi.layout.mode',
  'poi.layout.reverse',
  'poi.layout.isolate',
  'poi.webview.useFixedResolution',
  'poi.webview.width',
  'poi.webview.windowWidth',
  'poi.webview.windowUseFixedResolution',
  'poi.webview.ratio.vertical',
  'poi.webview.ratio.horizontal',
  'poi.tabarea.vertical',
  'poi.tabarea.double',
  'poi.tabarea.grid',
  // 概览里各面板的位置（react-grid-layout 的多断点坐标表），必须深拷贝后再存
  'poi.mainpanel.layout',
  'poi.appearance.zoom',
]

/** 写在最末：overlay 会锁尺寸规则，必须等其他键都生效后再开 */
const OVERLAY_KEY = 'poi.layout.overlay'

const DEFAULT_STORE = {
  version: 1,
  profiles: [],
  // 软删除：删掉的方案先放这儿，给一次后悔的机会
  deleted: [],
  // 最近一次套用的方案 id，面板用它给"使用中"打标
  activeProfileId: '',
  settings: {
    hotkeysEnabled: true,
    autoFit: true,
  },
}

/** 快照必须是独立副本：mainpanel.layout 是对象，react-grid-layout 会原地改它 */
const cloneJson = (value) => {
  if (value === null || typeof value !== 'object') return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (err) {
    return value
  }
}

export const uid = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const emptyStore = () => JSON.parse(JSON.stringify(DEFAULT_STORE))

export function loadStore() {
  try {
    if (!existsSync(STORE_FILE)) return emptyStore()
    const raw = readJsonSync(STORE_FILE)
    return normalizeStore(raw)
  } catch (err) {
    console.error('[layout-profiles] 方案文件损坏，已另存备份：', err)
    try {
      // 别把用户的方案直接写没了：坏文件留一份，然后从空库开始
      if (existsSync(STORE_FILE)) renameSync(STORE_FILE, STORE_BROKEN)
    } catch (e) {
      /* ignore */
    }
    return emptyStore()
  }
}

const normalizeStore = (raw) => {
  const base = emptyStore()
  if (!raw || typeof raw !== 'object') return base
  return {
    ...base,
    ...raw,
    profiles: (Array.isArray(raw.profiles) ? raw.profiles : []).filter(isUsableProfile),
    deleted: (Array.isArray(raw.deleted) ? raw.deleted : []).filter(isUsableProfile),
    settings: { ...base.settings, ...(raw.settings || {}) },
  }
}

/** 挡住导入的脏数据：没有 id/name、window 不是数字的整条丢掉 */
export function isUsableProfile(p) {
  if (!p || typeof p !== 'object') return false
  if (typeof p.id !== 'string' || !p.id) return false
  if (typeof p.name !== 'string') return false
  if (p.window && typeof p.window === 'object') {
    const ok = ['x', 'y', 'width', 'height'].every((k) => {
      const v = p.window[k]
      return v === undefined || Number.isFinite(Number(v))
    })
    if (!ok) return false
  }
  if (p.config && typeof p.config !== 'object') return false
  return true
}

/**
 * 原子写：先写 .tmp 再 rename 覆盖。
 * 直接覆盖 profiles.json 时若断电/崩溃，文件会变成半截 JSON，方案全丢。
 */
export function saveStore(store) {
  try {
    ensureDirSync(STORE_DIR)
    const payload = JSON.stringify(store, null, 2)
    writeFileSync(STORE_TMP, payload, 'utf8')
    try {
      renameSync(STORE_TMP, STORE_FILE)
    } catch (err) {
      // 极少数情况 rename 被占用（杀毒/索引服务），退回直接写
      writeJsonSync(STORE_FILE, store, { spaces: 2 })
    }
    return true
  } catch (err) {
    console.error('[layout-profiles] save failed:', err)
    return false
  }
}

export { getWindow, getScreen }

/** 读当前 poi 状态，做成可保存的快照 */
export function captureCurrent() {
  const win = getWindow()
  let normal
  try {
    normal = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
  } catch (err) {
    normal = win.getBounds()
  }
  const config = getConfig()
  const cfg = {}
  CONFIG_KEYS.forEach((key) => {
    try {
      const value = config.get(key)
      if (value !== undefined) cfg[key] = cloneJson(value)
    } catch (err) {
      /* 新版本删掉的键就跳过 */
    }
  })
  const overlay = Boolean(config.get(OVERLAY_KEY, false))
  if (overlay) cfg[OVERLAY_KEY] = true
  return {
    window: {
      x: normal.x,
      y: normal.y,
      width: normal.width,
      height: normal.height,
      isMaximized: Boolean(win.isMaximized()),
    },
    config: cfg,
    capturedAt: Date.now(),
    display: describeDisplay(win),
  }
}

/** 记录当前窗口落在哪块屏上，方便串流时换屏后重定位 */
function describeDisplay(win) {
  try {
    const screen = getScreen()
    const b = win.getBounds()
    const displays = screen.getAllDisplays()
    const hit =
      displays.find(
        (d) =>
          b.x + b.width / 2 >= d.bounds.x &&
          b.x + b.width / 2 <= d.bounds.x + d.bounds.width &&
          b.y + b.height / 2 >= d.bounds.y &&
          b.y + b.height / 2 <= d.bounds.y + d.bounds.height,
      ) || screen.getPrimaryDisplay()
    return {
      id: hit.id,
      label: hit.label || '',
      size: [hit.bounds.width, hit.bounds.height],
      workAreaSize: [hit.workArea.width, hit.workArea.height],
    }
  } catch (err) {
    return null
  }
}

/**
 * 算出这次应用实际要用的窗口矩形。
 * fit: 'bounds'   —— 用保存时的绝对坐标（多屏固定位置，最常用）
 * fit: 'display'  —— 铺满指定显示器的工作区（串流时分辨率变了也不会跑偏）
 * fit: 'scale'    —— 按当前主屏工作区等比缩放保存的尺寸
 */
export function resolveBounds(profile) {
  const win = getWindow()
  const saved = profile.window || { x: 80, y: 80, width: 960, height: 720 }
  const fit = profile.fit || 'bounds'
  let bounds = {
    x: Number(saved.x) || 0,
    y: Number(saved.y) || 0,
    width: Math.max(200, Number(saved.width) || 960),
    height: Math.max(200, Number(saved.height) || 720),
  }
  let isMaximized = Boolean(saved.isMaximized)

  let screen, displays
  try {
    screen = getScreen()
    displays = screen.getAllDisplays()
  } catch (err) {
    return { bounds: applyMinSize(win, bounds), isMaximized }
  }
  if (!displays || displays.length === 0) return { bounds: applyMinSize(win, bounds), isMaximized }

  const pickDisplay = () => {
    if (profile.display && profile.display.label) {
      const byLabel = displays.find((d) => d.label === profile.display.label)
      if (byLabel) return byLabel
    }
    if (profile.display && typeof profile.display.id === 'number') {
      const byId = displays.find((d) => d.id === profile.display.id)
      if (byId) return byId
    }
    // 保存时窗口中心在哪块屏，就还回哪块屏
    const cx = bounds.x + bounds.width / 2
    const cy = bounds.y + bounds.height / 2
    return (
      displays.find(
        (d) =>
          cx >= d.bounds.x &&
          cx <= d.bounds.x + d.bounds.width &&
          cy >= d.bounds.y &&
          cy <= d.bounds.y + d.bounds.height,
      ) || screen.getPrimaryDisplay()
    )
  }

  const target = pickDisplay()
  const wa = target.workArea

  if (fit === 'display') {
    bounds = { x: wa.x, y: wa.y, width: wa.width, height: wa.height }
    isMaximized = false
  } else if (fit === 'scale') {
    const scale = Math.min(wa.width / bounds.width, wa.height / bounds.height, 1)
    const width = Math.round(bounds.width * scale)
    const height = Math.round(bounds.height * scale)
    bounds = {
      x: Math.round(wa.x + (wa.width - width) / 2),
      y: Math.round(wa.y + (wa.height - height) / 2),
      width,
      height,
    }
    isMaximized = false
  } else {
    // 绝对坐标：只要窗口主体不在任何屏幕内，就夹回目标屏
    const visible =
      bounds.x + bounds.width > wa.x + 40 &&
      bounds.x < wa.x + wa.width - 40 &&
      bounds.y + bounds.height > wa.y + 40 &&
      bounds.y < wa.y + wa.height - 40
    if (!visible) {
      const width = Math.min(bounds.width, wa.width)
      const height = Math.min(bounds.height, wa.height)
      bounds = {
        x: Math.round(wa.x + (wa.width - width) / 2),
        y: Math.round(wa.y + (wa.height - height) / 2),
        width,
        height,
      }
      isMaximized = false
    }
  }
  return { bounds: applyMinSize(win, bounds), isMaximized }
}

/** poi 自己会设最小窗口尺寸，比它小的 setBounds 会被静默拒绝 */
function applyMinSize(win, bounds) {
  try {
    const [mw, mh] = win.getMinimumSize()
    return {
      ...bounds,
      width: Math.max(bounds.width, Number(mw) || 0),
      height: Math.max(bounds.height, Number(mh) || 0),
    }
  } catch (err) {
    return bounds
  }
}

const getConfig = () => require('views/env').config

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function releaseWindowConstraints(win) {
  try {
    win.setAspectRatio(0)
  } catch (err) {
    /* 旧版本可能没有 */
  }
  try {
    win.setResizable(true)
    win.setMaximizable(true)
    win.setFullScreenable(true)
  } catch (err) {
    /* ignore */
  }
  try {
    if (win.isFullScreen()) win.setFullScreen(false)
  } catch (err) {
    /* ignore */
  }
}

/** 连点两个方案时，只有最后一次生效 */
let applyToken = 0

/** 应用一套方案（异步，含 poi 自身的抖动补偿） */
export async function applyProfile(profile) {
  const myToken = ++applyToken
  const alive = () => myToken === applyToken && isAlive(getWindow())

  const win = getWindow()
  if (!isAlive(win)) return { skipped: true }
  releaseWindowConstraints(win)

  const config = getConfig()
  const cfg = profile.config || {}
  const overlay = Boolean(cfg[OVERLAY_KEY])

  // 1) 先关掉 overlay，否则它会把窗口锁成"游戏区+面板"的固定尺寸
  if (!overlay) {
    try {
      config.set(OVERLAY_KEY, false)
    } catch (err) {
      /* ignore */
    }
  }

  // 2) 其余配置按固定顺序写入；poi 的 layout.js 会逐条即时重排
  CONFIG_KEYS.forEach((key) => {
    if (!(key in cfg)) return
    try {
      config.set(key, cloneJson(cfg[key]))
    } catch (err) {
      console.error(`[layout-profiles] set ${key} failed`, err)
    }
  })

  // 3) 窗口几何。zoom 分支会在 1 秒后把尺寸"恢复"成它自己记下的值，
  //    所以分三次校正：立即、250ms、1500ms。
  //    注意 overlay 必须在几何校正之后再开：它会给窗口加宽高比锁，
  //    提前开会把后面的 setBounds 全部约束掉。
  const { bounds, isMaximized } = resolveBounds(profile)

  const setGeometry = () => {
    if (!alive()) return
    const target = getWindow()
    try {
      releaseWindowConstraints(target)
      if (target.isMaximized()) target.unmaximize()
      if (isMaximized) {
        target.setBounds(bounds)
        setTimeout(() => {
          if (!alive()) return
          try {
            const w = getWindow()
            if (!w.isMaximized()) w.maximize()
          } catch (err) {
            /* ignore */
          }
        }, 60)
      } else {
        target.setBounds(bounds)
      }
    } catch (err) {
      console.error('[layout-profiles] setBounds failed', err)
    }
  }

  setGeometry()
  await sleep(250)
  if (alive()) setGeometry()
  await sleep(1250)
  if (alive()) setGeometry()

  // 4) overlay 最后开：poi 会按"游戏区 + 面板宽度"重算一次窗口，这是它该做的
  if (overlay && alive()) {
    try {
      config.set(OVERLAY_KEY, true)
    } catch (err) {
      /* ignore */
    }
  }

  return { bounds, isMaximized, skipped: myToken !== applyToken }
}

/** 启动时按参数自动套用：poi.exe --layout-profile=名字 / 环境变量 POI_LAYOUT_PROFILE */
export function autoProfileName() {
  try {
    const proc = getRemote().process
    const argv = proc.argv || []
    const hit = argv.find((a) => /^--layout-profile=/i.test(a))
    if (hit) return hit.split('=').slice(1).join('=').trim()
    const fromEnv = proc.env && proc.env.POI_LAYOUT_PROFILE
    return fromEnv ? String(fromEnv).trim() : ''
  } catch (err) {
    return ''
  }
}

/** 当前状态摘要（给 UI 显示） */
export function describeProfile(profile) {
  const cfg = (profile && profile.config) || {}
  const mode = cfg['poi.layout.mode'] === 'vertical' ? '纵' : '横'
  const zoom = Math.round(Number(cfg['poi.appearance.zoom'] || 1) * 100)
  const gameW = cfg['poi.webview.useFixedResolution']
    ? `${cfg['poi.webview.width'] || '?'}px`
    : '自适应'
  const tab = cfg['poi.tabarea.vertical'] ? '侧栏' : '底栏'
  const win = (profile && profile.window) || {}
  const hasPanel = cfg['poi.mainpanel.layout'] ? ' · 面板布局' : ''
  return `${mode}屏 · ${zoom}% · 游戏区 ${gameW} · ${tab} · ${win.width || 0}×${win.height || 0}${hasPanel}`
}

/** 轻量摘要：只读 3 个键，给面板的"当前状态"行高频刷新用 */
export function quickSummary() {
  try {
    const config = getConfig()
    const win = getWindow()
    const b = win.getBounds()
    const mode = config.get('poi.layout.mode') === 'vertical' ? '纵' : '横'
    const zoom = Math.round(Number(config.get('poi.appearance.zoom') || 1) * 100)
    const gw = config.get('poi.webview.useFixedResolution')
      ? `${config.get('poi.webview.width')}px`
      : '自适应'
    return `${mode}屏 · ${zoom}% · 游戏区 ${gw} · ${b.width}×${b.height}`
  } catch (err) {
    return ''
  }
}
