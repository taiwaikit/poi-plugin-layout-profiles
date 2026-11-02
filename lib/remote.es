/*
 * remote 兼容层。
 * poi 11 起切到 @electron/remote（Electron 14+ 禁用了内置 remote），
 * 老版本还在用 require('electron').remote。插件要能同时装在两代 poi 上，
 * 就不能在文件顶部写死 import —— 模块不存在时顶层 require 会直接抛错，
 * 整个插件加载失败。这里统一走惰性 require。
 */
let cached = null

export function getRemote() {
  if (cached) return cached
  try {
    cached = require('@electron/remote')
    return cached
  } catch (err) {
    /* poi <= 10 */
  }
  try {
    cached = require('electron').remote
    return cached
  } catch (err) {
    cached = null
    throw new Error('无法获取 electron remote，poi 版本可能过旧')
  }
}

/** 主进程 electron 模块：screen / dialog / globalShortcut 都从这里拿 */
export function getElectron() {
  return getRemote().require('electron')
}

export const getWindow = () => getRemote().getCurrentWindow()

export const getScreen = () => getElectron().screen

export const isAlive = (win) => {
  try {
    return !!win && !(typeof win.isDestroyed === 'function' && win.isDestroyed())
  } catch (err) {
    return false
  }
}
