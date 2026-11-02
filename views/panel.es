import React from 'react'
import PropTypes from 'prop-types'
import {
  Button,
  Card,
  Divider,
  InputGroup,
  Switch,
  Tag,
  Callout,
  HTMLSelect,
  Intent,
} from '@blueprintjs/core'

import {
  loadStore,
  saveStore,
  captureCurrent,
  applyProfile,
  describeProfile,
  quickSummary,
  isUsableProfile,
  uid,
} from '../lib/profiles.es'
import { syncHotkeys, eventToAccelerator } from '../lib/hotkeys.es'
import { getWindow, getElectron } from '../lib/remote.es'

const getDialog = () => {
  try {
    return getElectron().dialog
  } catch (err) {
    return null
  }
}

const FIT_OPTIONS = [
  { value: 'bounds', label: '记住坐标（多屏固定）' },
  { value: 'display', label: '铺满所在屏' },
  { value: 'scale', label: '等比缩放' },
]

export default class LayoutProfilesPanel extends React.Component {
  static propTypes = {
    layoutProfilesActions: PropTypes.object,
  }

  constructor(props) {
    super(props)
    this.state = {
      store: loadStore(),
      newName: '',
      editingId: '',
      editingName: '',
      busyId: '',
      message: null,
      hotkeyFailures: [],
      // 二次确认：串流时手指容易点偏，覆盖/删除都要求连点两下
      confirm: '',
      // 实时显示的当前窗口状态，切方案后能立刻对照
      liveSummary: '',
      // 正在录快捷键的方案 id
      recordingId: '',
    }
  }

  componentDidMount() {
    this.refreshHotkeys()
    this.updateLiveSummary()

    // config 变化（切方案、拖窗口、改缩放）由 poi 自己 emit，收到就刷新
    try {
      const { config } = require('views/env')
      this.configListener = () => this.setState({ liveSummary: quickSummary() })
      config.on('config.set', this.configListener)
    } catch (err) {
      /* 老版本没有事件就用轮询兜底 */
    }
    // 兜底轮询放慢到 5 秒，正常路径靠事件
    this.liveTimer = window.setInterval(this.updateLiveSummary, 5000)
  }

  componentWillUnmount() {
    if (this.confirmTimer) window.clearTimeout(this.confirmTimer)
    if (this.liveTimer) window.clearInterval(this.liveTimer)
    if (this.configListener) {
      try {
        require('views/env').config.removeListener('config.set', this.configListener)
      } catch (err) {
        /* ignore */
      }
      this.configListener = null
    }
  }

  updateLiveSummary = () => {
    try {
      // 只读 3 个键：config 是主进程对象，每次 get 都是同步 IPC，
      // 别在高频刷新里走完整快照。
      this.setState({ liveSummary: quickSummary() })
    } catch (err) {
      /* ignore */
    }
  }

  /**
   * 危险操作二次确认：第一次点只是"上膛"，3.5 秒内再点同一颗按钮才真正执行。
   * 不用弹窗，是因为串流时弹窗要点两处，反而更容易误触。
   */
  armConfirm = (key, run) => {
    if (this.state.confirm === key) {
      if (this.confirmTimer) window.clearTimeout(this.confirmTimer)
      this.setState({ confirm: '' })
      run()
      return
    }
    if (this.confirmTimer) window.clearTimeout(this.confirmTimer)
    this.setState({ confirm: key })
    this.confirmTimer = window.setTimeout(() => this.setState({ confirm: '' }), 3500)
  }

  persist = (store) => {
    saveStore(store)
    this.setState({ store })
  }

  refreshHotkeys = () => {
    const result = syncHotkeys(this.state.store)
    this.setState({ hotkeyFailures: result.failed })
  }

  flash = (text, intent = Intent.SUCCESS) => {
    this.setState({ message: { text, intent } })
    window.setTimeout(() => this.setState({ message: null }), 4000)
  }

  handleSave = () => {
    const { store, newName } = this.state
    const snapshot = captureCurrent()
    const name = (newName || '').trim() || this.autoNameFrom(snapshot)
    const profile = {
      id: uid(),
      name,
      fit: 'bounds',
      hotkey: '',
      isDefault: store.profiles.length === 0,
      ...snapshot,
    }
    const next = { ...store, profiles: [...store.profiles, profile] }
    this.persist(next)
    this.refreshHotkeys()
    this.setState({ newName: '' })
    this.flash(`已保存「${name}」：${describeProfile(profile)}`)
  }

  autoNameFrom = (snapshot) => {
    const cfg = (snapshot || captureCurrent()).config
    const mode = cfg['poi.layout.mode'] === 'vertical' ? '竖屏' : '横屏'
    const zoom = Math.round(Number(cfg['poi.appearance.zoom'] || 1) * 100)
    return `${mode} ${zoom}%`
  }

  handleApply = async (profile) => {
    this.setState({ busyId: profile.id })
    try {
      await applyProfile(profile)
      this.persist({ ...this.state.store, activeProfileId: profile.id })
      this.flash(`已切换到「${profile.name}」`)
    } catch (err) {
      this.flash(`切换失败：${err && err.message}`, Intent.DANGER)
    } finally {
      this.setState({ busyId: '' })
    }
  }

  handleCaptureInto = (profile) => {
    const { store } = this.state
    const snapshot = captureCurrent()
    const next = {
      ...store,
      profiles: store.profiles.map((p) =>
        p.id === profile.id ? { ...p, ...snapshot, name: p.name, fit: p.fit, hotkey: p.hotkey } : p,
      ),
    }
    this.persist(next)
    this.flash(`「${profile.name}」已更新为当前状态`)
  }

  handleDelete = (profile) => {
    const { store } = this.state
    const next = {
      ...store,
      profiles: store.profiles.filter((p) => p.id !== profile.id),
      deleted: [{ ...profile, deletedAt: Date.now() }, ...(store.deleted || [])].slice(0, 8),
      activeProfileId: store.activeProfileId === profile.id ? '' : store.activeProfileId,
    }
    this.persist(next)
    this.refreshHotkeys()
    this.flash(`已删除「${profile.name}」，可在下方「最近删除」恢复`)
  }

  handleRestore = (profile) => {
    const { store } = this.state
    const next = {
      ...store,
      profiles: [...store.profiles, { ...profile, deletedAt: undefined }],
      deleted: (store.deleted || []).filter((p) => p.id !== profile.id),
    }
    this.persist(next)
    this.refreshHotkeys()
    this.flash(`已恢复「${profile.name}」`)
  }

  handlePurge = () => {
    const { store } = this.state
    this.persist({ ...store, deleted: [] })
    this.flash('已清空最近删除')
  }

  handleFitChange = (profile, fit) => {
    const { store } = this.state
    const next = {
      ...store,
      profiles: store.profiles.map((p) => (p.id === profile.id ? { ...p, fit } : p)),
    }
    this.persist(next)
  }

  handleDefault = (profile) => {
    const { store } = this.state
    const next = {
      ...store,
      profiles: store.profiles.map((p) => ({ ...p, isDefault: p.id === profile.id })),
    }
    this.persist(next)
  }

  handleHotkeyKeyDown = (e, profile) => {
    e.preventDefault()
    e.stopPropagation()
    const accel = eventToAccelerator(e)
    if (!accel) return
    const { store } = this.state
    const value = accel === '__CLEAR__' ? '' : accel
    if (!value) {
      const { store: s0 } = this.state
      this.persist({
        ...s0,
        profiles: s0.profiles.map((p) => (p.id === profile.id ? { ...p, hotkey: '' } : p)),
      })
      this.refreshHotkeys()
      this.flash(`已清除「${profile.name}」的快捷键`)
      return
    }
    if (value) {
      const dup = (store.profiles || []).find(
        (p) => p.id !== profile.id && (p.hotkey || '').toLowerCase() === value.toLowerCase(),
      )
      if (dup) {
        this.flash(`这个组合已被「${dup.name}」占用`, Intent.DANGER)
        return
      }
    }
    const next = {
      ...store,
      profiles: store.profiles.map((p) => (p.id === profile.id ? { ...p, hotkey: value } : p)),
    }
    this.persist(next)
    this.refreshHotkeys()
  }

  handleRenameCommit = (profile) => {
    const name = (this.state.editingName || '').trim()
    const { store } = this.state
    if (!name) {
      this.setState({ editingId: '', editingName: '' })
      return
    }
    const next = {
      ...store,
      profiles: store.profiles.map((p) => (p.id === profile.id ? { ...p, name } : p)),
    }
    this.persist(next)
    this.setState({ editingId: '', editingName: '' })
  }

  handleSettings = (patch) => {
    const { store } = this.state
    const next = { ...store, settings: { ...store.settings, ...patch } }
    this.persist(next)
    this.refreshHotkeys()
  }

  handleExport = async () => {
    try {
      const dialog = getDialog()
      const res = await dialog.showSaveDialog(getWindow(), {
        title: '导出布局方案',
        defaultPath: 'poi-layout-profiles.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      const file = res && (res.filePath || res)
      if (!file) return
      require('fs').writeFileSync(file, JSON.stringify(this.state.store, null, 2), 'utf8')
      this.flash(`已导出到 ${file}`)
    } catch (err) {
      this.flash(`导出失败：${err && err.message}`, Intent.DANGER)
    }
  }

  handleImport = async () => {
    try {
      const dialog = getDialog()
      const res = await dialog.showOpenDialog(getWindow(), {
        title: '导入布局方案',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      const files = res && (res.filePaths || res)
      if (!files || !files[0]) return
      const raw = JSON.parse(require('fs').readFileSync(files[0], 'utf8'))
      if (!raw || !Array.isArray(raw.profiles)) throw new Error('文件格式不对')
      const incoming = raw.profiles.filter(isUsableProfile)
      if (incoming.length === 0) throw new Error('文件里没有可用的方案')
      raw.profiles = incoming
      const { store } = this.state
      const existing = new Set(store.profiles.map((p) => p.id))
      const merged = [
        ...store.profiles,
        ...raw.profiles.map((p) => (existing.has(p.id) ? { ...p, id: uid() } : p)),
      ]
      this.persist({ ...store, profiles: merged })
      this.refreshHotkeys()
      this.flash(`已导入 ${raw.profiles.length} 套方案`)
    } catch (err) {
      this.flash(`导入失败：${err && err.message}`, Intent.DANGER)
    }
  }

  renderProfile(profile) {
    const { editingId, editingName, busyId, store } = this.state
    const isEditing = editingId === profile.id
    const fail = this.state.hotkeyFailures.find((f) => f.id === profile.id)
    const armedCapture = this.state.confirm === `capture:${profile.id}`
    const armedDelete = this.state.confirm === `delete:${profile.id}`
    const isActive = store.activeProfileId === profile.id
    const recording = this.state.recordingId === profile.id
    return (
      <Card
        key={profile.id}
        style={{
          marginBottom: 8,
          padding: 10,
          borderLeft: isActive ? '3px solid #2d72d2' : '3px solid transparent',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isEditing ? (
            <InputGroup
              small
              autoFocus
              value={editingName}
              onChange={(e) => this.setState({ editingName: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') this.handleRenameCommit(profile)
                if (e.key === 'Escape') this.setState({ editingId: '', editingName: '' })
              }}
              onBlur={() => this.handleRenameCommit(profile)}
              style={{ flex: 1 }}
            />
          ) : (
            <span
              style={{ flex: 1, fontWeight: 600, cursor: 'text' }}
              onClick={() => this.setState({ editingId: profile.id, editingName: profile.name })}
              title="点击改名"
            >
              {profile.name}
              {isActive ? (
                <Tag intent={Intent.PRIMARY} minimal style={{ marginLeft: 6 }}>
                  使用中
                </Tag>
              ) : null}
              {profile.isDefault ? (
                <Tag minimal style={{ marginLeft: 6 }}>
                  默认
                </Tag>
              ) : null}
            </span>
          )}
          <Button
            intent={Intent.PRIMARY}
            loading={busyId === profile.id}
            onClick={() => this.handleApply(profile)}
          >
            切换
          </Button>
        </div>

        <div style={{ fontSize: 11, opacity: 0.7, margin: '6px 0' }}>
          {describeProfile(profile)}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <HTMLSelect
            minimal
            value={profile.fit || 'bounds'}
            options={FIT_OPTIONS}
            onChange={(e) => this.handleFitChange(profile, e.target.value)}
          />
          <div
            tabIndex={0}
            onKeyDown={(e) => this.handleHotkeyKeyDown(e, profile)}
            onFocus={() => this.setState({ recordingId: profile.id })}
            onBlur={() => this.setState({ recordingId: '' })}
            style={{
              minWidth: 150,
              minHeight: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '4px 10px',
              fontSize: recording ? 11 : 12,
              borderRadius: 3,
              border: `1px solid ${
                recording ? '#2d72d2' : fail ? '#c23030' : 'rgba(120,120,120,0.45)'
              }`,
              background: recording ? 'rgba(45,114,210,0.12)' : 'transparent',
              cursor: 'pointer',
              userSelect: 'none',
            }}
            title="点这里，然后按组合键；Esc 清除"
          >
            {recording ? '按下组合键…（Esc 清除）' : profile.hotkey || '点击设置快捷键'}
          </div>
          <Button
            minimal
            intent={armedCapture ? Intent.WARNING : Intent.NONE}
            onClick={() =>
              this.armConfirm(`capture:${profile.id}`, () => this.handleCaptureInto(profile))
            }
          >
            {armedCapture ? '确认覆盖？' : '存为当前'}
          </Button>
          <Button minimal onClick={() => this.handleDefault(profile)}>
            设默认
          </Button>
          <Button
            minimal
            intent={armedDelete ? Intent.DANGER : Intent.NONE}
            onClick={() => this.armConfirm(`delete:${profile.id}`, () => this.handleDelete(profile))}
          >
            {armedDelete ? '确认删除？' : '删除'}
          </Button>
        </div>
        {fail ? (
          <div style={{ fontSize: 11, color: '#c23030', marginTop: 4 }}>
            快捷键 {fail.hotkey} 注册失败：{fail.reason}
          </div>
        ) : null}
      </Card>
    )
  }

  render() {
    const { store, newName, message } = this.state
    const profiles = store.profiles || []
    const settings = store.settings || {}

    const deleted = store.deleted || []

    return (
      <div style={{ padding: 8, height: '100%', overflowY: 'auto' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            marginBottom: 8,
            padding: '6px 8px',
            borderRadius: 3,
            background: 'rgba(120,120,120,0.12)',
            fontSize: 11,
          }}
        >
          <span style={{ opacity: 0.65 }}>当前</span>
          <span style={{ flex: 1 }}>{this.state.liveSummary || '读取中…'}</span>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <InputGroup
            small
            placeholder="方案名，留空自动命名"
            value={newName}
            onChange={(e) => this.setState({ newName: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') this.handleSave()
            }}
            style={{ flex: 1 }}
          />
          <Button small intent={Intent.SUCCESS} icon="floppy-disk" onClick={this.handleSave}>
            保存当前
          </Button>
        </div>

        <div
          style={{ display: 'flex', gap: 14, marginBottom: 10, fontSize: 12, flexWrap: 'wrap' }}
        >
          <Switch
            checked={settings.hotkeysEnabled !== false}
            label="启用全局快捷键"
            onChange={(e) => this.handleSettings({ hotkeysEnabled: e.target.checked })}
          />
          <Switch
            checked={Boolean(settings.autoApplyDefault)}
            label="启动时套用默认方案"
            onChange={(e) => this.handleSettings({ autoApplyDefault: e.target.checked })}
          />
          <Switch
            checked={Boolean(settings.autoFitOnStream)}
            label="窗口移出屏幕时自动夹回"
            onChange={(e) => this.handleSettings({ autoFitOnStream: e.target.checked })}
          />
        </div>

        {message ? (
          <Callout intent={message.intent} style={{ marginBottom: 8, fontSize: 12 }}>
            {message.text}
          </Callout>
        ) : null}

        <Divider />

        {profiles.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.7, padding: '12px 0' }}>
            还没有方案。把 poi 调成你躺着看的样子，然后点「保存当前」。
          </div>
        ) : (
          profiles.map((p) => this.renderProfile(p))
        )}

        {deleted.length > 0 ? (
          <div style={{ marginTop: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 4px' }}>
              <div style={{ flex: 1, height: 1, background: 'rgba(120,120,120,0.35)' }} />
              <span style={{ fontSize: 11, opacity: 0.6 }}>最近删除（{deleted.length}）</span>
              <div style={{ flex: 1, height: 1, background: 'rgba(120,120,120,0.35)' }} />
            </div>
            {deleted.map((item) => (
              <div
                key={`d-${item.id}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 2px',
                  fontSize: 12,
                  opacity: 0.75,
                }}
              >
                <span style={{ flex: 1 }}>{item.name}</span>
                <span style={{ fontSize: 11, opacity: 0.6 }}>{describeProfile(item)}</span>
                <Button minimal small onClick={() => this.handleRestore(item)}>
                  恢复
                </Button>
              </div>
            ))}
            <Button minimal small icon="trash" intent={Intent.DANGER} onClick={this.handlePurge}>
              清空
            </Button>
          </div>
        ) : null}

        <Divider />
        <div style={{ display: 'flex', gap: 6, paddingBottom: 12 }}>
          <Button small minimal icon="export" onClick={this.handleExport}>
            导出
          </Button>
          <Button small minimal icon="import" onClick={this.handleImport}>
            导入
          </Button>
        </div>
      </div>
    )
  }
}
