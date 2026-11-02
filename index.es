/*
 * poi-plugin-layout-profiles
 * 一键切换 poi 的「布局模式 + 缩放 + 游戏分辨率 + 窗口尺寸/位置」组合。
 *
 * 为什么能这么做：poi 本体 views/services/layout.js 监听 config.set，
 * 收到 poi.appearance.zoom / poi.layout.* / poi.webview.* / poi.tabarea.*
 * 就会立刻重排窗口与游戏区；窗口几何又由 lib/window.js 自动写回
 * poi.window。所以插件只是一层"预设管理器"，不碰任何私有实现。
 */
import LayoutProfilesPanel from './views/panel.es'
import { loadStore, saveStore, autoProfileName, applyProfile } from './lib/profiles.es'
import { syncHotkeys, unregisterAll } from './lib/hotkeys.es'
import { getElectron, getWindow, isAlive } from './lib/remote.es'

export const reactClass = LayoutProfilesPanel

let moveTimer = null
let moveHandler = null
let screenHandler = null

const findProfile = (store, key) => {
  if (!key) return null
  const k = String(key).trim().toLowerCase()
  return (
    store.profiles.find((p) => String(p.id).toLowerCase() === k) ||
    store.profiles.find((p) => String(p.name).trim().toLowerCase() === k) ||
    null
  )
}

export function pluginDidLoad() {
  try {
    const store = loadStore()
    syncHotkeys(store)

    // 启动自动套用：poi.exe --layout-profile=竖屏串流  或  环境变量 POI_LAYOUT_PROFILE
    const wanted = autoProfileName()
    let target = findProfile(store, wanted)
    if (!wanted && store.settings && store.settings.autoApplyDefault) {
      target = store.profiles.find((p) => p.isDefault)
    }
    if (target) {
      // 等 poi 自己把主界面布局跑完再套，避免互相覆盖
      window.setTimeout(() => {
        applyProfile(target)
          .then(() => {
            // 面板靠这个字段给"使用中"打标
            try {
              saveStore({ ...loadStore(), activeProfileId: target.id })
            } catch (err) {
              /* ignore */
            }
          })
          .catch((err) => console.error('[layout-profiles] auto apply failed', err))
      }, 3000)
      console.log(`[layout-profiles] 启动套用方案：${target.name}`)
    }

    // 可选：窗口整体跑到所有屏幕之外时自动拉回来（串流端改分辨率后最常见）
    const win = getWindow()
    if (!isAlive(win)) return

    const clampIfOffscreen = () => {
      const fresh = loadStore()
      if (!fresh.settings || !fresh.settings.autoFitOnStream) return
      try {
        const screen = getElectron().screen
        const b = getWindow().getBounds()
        const displays = screen.getAllDisplays()
        const visible = displays.some(
          (d) =>
            b.x + b.width > d.bounds.x + 80 &&
            b.x < d.bounds.x + d.bounds.width - 80 &&
            b.y + b.height > d.bounds.y + 80 &&
            b.y < d.bounds.y + d.bounds.height - 80,
        )
        if (visible) return
        const wa = screen.getPrimaryDisplay().workArea
        const width = Math.min(b.width, wa.width - 40)
        const height = Math.min(b.height, wa.height - 40)
        getWindow().setBounds({
          x: wa.x + Math.round((wa.width - width) / 2),
          y: wa.y + Math.round((wa.height - height) / 2),
          width,
          height,
        })
        console.log('[layout-profiles] 窗口原本在屏幕外，已夹回主屏')
      } catch (err) {
        /* ignore */
      }
    }

    const scheduleClamp = (delay) => {
      if (moveTimer) window.clearTimeout(moveTimer)
      moveTimer = window.setTimeout(clampIfOffscreen, delay)
    }

    moveHandler = () => scheduleClamp(800)
    win.on('move', moveHandler)

    // 分辨率 / 显示器插拔：串流端切分辨率时窗口不会触发 move，只能靠这些事件
    screenHandler = () => scheduleClamp(1200)
    try {
      const screen = getElectron().screen
      ;['display-metrics-changed', 'display-added', 'display-removed'].forEach((evt) => {
        screen.on(evt, screenHandler)
      })
    } catch (err) {
      console.error('[layout-profiles] screen 事件监听失败', err)
    }

    console.log('[layout-profiles] loaded')
  } catch (err) {
    console.error('[layout-profiles] pluginDidLoad failed', err)
  }
}

export function pluginWillUnload() {
  try {
    unregisterAll()
    const win = getWindow()
    if (moveHandler && isAlive(win)) win.removeListener('move', moveHandler)
    if (moveTimer) window.clearTimeout(moveTimer)
    if (screenHandler) {
      const screen = getElectron().screen
      ;['display-metrics-changed', 'display-added', 'display-removed'].forEach((evt) => {
        try {
          screen.removeListener(evt, screenHandler)
        } catch (err) {
          /* ignore */
        }
      })
    }
  } catch (err) {
    /* ignore */
  }
}
