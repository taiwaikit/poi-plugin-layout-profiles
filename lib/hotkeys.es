/*
 * 全局快捷键：串流时插件面板可能根本看不见，所以热键是主入口。
 * poi 本体只用 globalShortcut 注册了 bosskey，其余键位由插件自行管理。
 */
import { getElectron } from './remote.es'
import { applyProfile, loadStore } from './profiles.es'

const registered = []

export function unregisterAll() {
  let gs
  try {
    gs = getElectron().globalShortcut
  } catch (err) {
    return
  }
  registered.splice(0).forEach((accel) => {
    try {
      gs.unregister(accel)
    } catch (err) {
      /* ignore */
    }
  })
}

/**
 * 按 store 里的绑定重挂全部热键。
 * 返回 { ok: [...], failed: [{id, hotkey, reason}] }
 */
export function syncHotkeys(store) {
  unregisterAll()
  const result = { ok: [], failed: [] }
  if (!store || !store.settings || store.settings.hotkeysEnabled === false) return result

  let gs
  try {
    gs = getElectron().globalShortcut
  } catch (err) {
    return result
  }

  ;(store.profiles || []).forEach((profile) => {
    const hotkey = (profile.hotkey || '').trim()
    if (!hotkey) return
    try {
      const ok = gs.register(hotkey, () => {
        // 用户可能刚"存为当前"覆盖过这套方案，热键必须用最新数据，
        // 不能吃注册那一刻闭包里的旧快照。
        const fresh = (loadStore().profiles || []).find((p) => p.id === profile.id)
        if (!fresh) return
        applyProfile(fresh).catch((err) =>
          console.error('[layout-profiles] hotkey apply failed', err),
        )
      })
      if (ok) {
        registered.push(hotkey)
        result.ok.push({ id: profile.id, hotkey })
      } else {
        result.failed.push({ id: profile.id, hotkey, reason: '已被其他程序占用' })
      }
    } catch (err) {
      result.failed.push({ id: profile.id, hotkey, reason: String(err && err.message) })
    }
  })
  return result
}

/** 把键盘事件转成 Electron accelerator，例：CommandOrControl+Alt+1 */
export function eventToAccelerator(e) {
  const mods = []
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')

  const raw = e.key
  if (!raw) return ''
  const ignore = ['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'Dead']
  if (ignore.includes(raw)) return ''
  if (raw === 'Escape') return '__CLEAR__'
  if (mods.length === 0) return ''

  let key = raw
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  else if (/^F\d{1,2}$/.test(key)) key = key.toUpperCase()
  else if (key === 'ArrowUp') key = 'Up'
  else if (key === 'ArrowDown') key = 'Down'
  else if (key === 'ArrowLeft') key = 'Left'
  else if (key === 'ArrowRight') key = 'Right'

  return [...mods, key].join('+')
}
