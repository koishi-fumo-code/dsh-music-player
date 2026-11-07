/**
 * dsh-music-player —— 本地音乐播放器 · 浏览器半端
 * ============================================================================
 * client bundle 不是 ESM，是自注册脚本（DSH 的约定）：
 *
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })
 *
 * 往**左侧图标条**写入口的写法（抄宿主自带面板）：
 *   · `sidebar.panellist`：登记一条 { name, id, order, label } + 图标组件
 *     —— 这是左侧那条竖排图标，label 是折叠时的 tooltip。
 *   · `main`（root 作用域 keyed slot）：用**同一个 id** 登记面板正文。
 *     选中图标后宿主渲染的就是它。（`conversation` 是会话保留 key，别用。）
 *
 * 播放全部在本机浏览器里：
 *   · 选文件用 <input type="file"> / 拖拽，Audio 元素播 Blob URL；
 *   · 元数据自己解析 ID3v2（MP3）和 FLAC（Vorbis comment + PICTURE），
 *     读歌名/歌手/专辑/内嵌封面 —— 零联网、零依赖、文件不上传。
 *
 * 教训（与 fx-arena 一致）：面板切到会话就卸载，组件里的定时器跟着没。
 * 所以播放引擎 + 播放列表放**模块作用域**，面板只是订阅者：切走只退订，
 * 歌照放；切回来直接接上当前进度。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-music-player',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const ENTRY_ID = 'music-player'
    const PREF_KEY = 'dsh-music-player.prefs'

    /* ───────────────────────── 小工具 ───────────────────────── */
    const pad2 = (n) => (n < 10 ? '0' + n : '' + n)
    const fmtTime = (sec) => {
      const s = Math.max(0, Math.floor(Number(sec) || 0))
      const hh = Math.floor(s / 3600)
      const mm = Math.floor((s % 3600) / 60)
      const ss = s % 60
      return hh > 0 ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`
    }
    const AUDIO_EXT = /\.(mp3|flac|wav|wave|ogg|oga|m4a|aac|opus|wma|aiff?|alac|ape|wv|mp4|webm|dsf|dff)$/i
    const DSD_EXT = /\.(dsf|dff)$/i
    const ACCEPT = '.mp3,.flac,.wav,.wave,.ogg,.oga,.m4a,.aac,.opus,.wma,.aiff,.aif,.alac,.ape,.wv,.mp4,.webm,.dsf,.dff,audio/*'

    // foobar2000 的 18 段均衡器频段（foo_dsp_eq 用的就是这组中心频率）
    const EQ_FREQS = [55, 77, 110, 156, 220, 311, 440, 622, 880, 1200, 1700, 2400, 3100, 4400, 6200, 8800, 12000, 16000]
    // 预设直接取自本机 D:\foobar2000\Equalizer Presets\*.feq（18 个值，单位 dB）
    const EQ_PRESETS = {
      'Flat': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      '1965': [-20, -16, -7, -4, -4, -4, -7, -7, 3, 3, -2, -4, 4, 1, 1, -4, -6, -12],
      'Air': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 2],
      'Brittle': [-12, -10, -9, -8, -7, -6, -5, -3, -2, -2, -2, -2, -1, 1, 4, 4, 1, 0],
      'Car Stereo': [-5, 0, 1, 0, 0, -4, -4, -5, -5, -5, -3, -2, -2, 0, 1, 0, -2, -5],
      'Classic V': [5, 2, 0, -2, -5, -6, -8, -8, -7, -7, -4, -3, -1, 1, 3, 5, 5, 4],
      'Clear': [1, 1, 0, 0, 0, -3, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 1],
      'Dark': [-6, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -5, -8, -10, -12, -14, -18, -18],
      'DEATH': [20, 17, 12, 8, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      'Drums': [2, 1, 0, 0, 0, -2, 0, -2, 0, 0, 0, 0, 2, 0, 0, 3, 0, 0],
      'Home Theater': [5, 2, 0, -2, -3, -5, -6, -6, -5, -2, -1, 0, -1, -3, 3, 4, 3, 0],
      'Loudness': [4, 4, 4, 2, -2, -2, -2, -2, -2, -2, -2, -4, -10, -7, 0, 3, 4, 4],
      'Metal': [4, 5, 5, 3, 0, -1, -2, -1, 0, 1, 1, 1, 1, 0, -1, -1, -1, -1],
      'Pop': [6, 5, 3, 0, -2, -4, -4, -6, -3, 1, 0, 0, 2, 1, 2, 4, 5, 6],
      'Premaster': [0, 1, 3, 0, -3, -3, 0, 0, 0, 2, 0, 0, 3, 0, 3, 1, 3, 2],
      'Presence': [0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 5, 4, 3, 2, 0, 0, 0, 0],
      'Punch & Sparkle': [3, 5, 3, -1, -3, -5, -5, -3, -2, 1, 1, 1, 0, 2, 1, 3, 5, 3],
      'Shimmer': [0, 0, 0, -2, -2, -7, -5, 0, 0, 0, 0, 0, 4, 1, 3, 3, 4, 0],
      'Soft Bass': [3, 5, 4, 0, -13, -7, -5, -5, -1, 2, 5, 1, -1, -1, -2, -7, -9, -14],
      'Strings': [-3, -4, -4, -5, -5, -4, -4, -3, -2, -2, -2, -2, -1, 2, 3, 0, -2, -2],
    }

    /**
     * 默认设置：按《Foobar2000 与小尾巴配置教程》里的取值来。
     * ==========================================================================
     * 教程实际步骤（OCR 自视频，原话见 README「教程对齐」一节）：
     *   ① 组件：装完整版（含 foo_input_sacd / foo_dsd_processor / ASIO 等）
     *   ② Preferences → 播放：播放增益「源模式=处理」，其余保持默认
     *   ③ Preferences → DSP 管理器：**已装的 DSP 留空**（教程要求这里不要挂东西）
     *   ④ Preferences → 输出 → 设备：缓冲长度 1000 毫秒
     *      （教程强调「设置太低可能引起爆音/卡顿」）
     *   ⑤ Preferences → 输出 → ASIO：选小尾巴的驱动，时钟「默认」，开独占
     *   ⑥ Preferences → 工具 → DSD：输出类型 PCM → DSD，转换模式「直通」
     *   ⑦ 拖 DSF 文件进主界面试听，不报错、能出声即完成
     * ==========================================================================
     */
    const SETTINGS_KEY = 'dsh-music-player.settings'
    const DEFAULT_SETTINGS = {
      eqEnabled: false,
      eqPreset: 'Flat',
      eqBands: EQ_PRESETS.Flat.slice(),
      eqPreamp: 0,
      stopResets: true,
      autoNext: true,
      showIndex: true,
      showArtist: true,
      showDuration: true,
      compact: false,
      searchScope: 'all', // all | title | artist | album
      readTags: true,
      readCover: true,
      // ── 对齐教程 ──
      dsdDecode: true,          // 教程⑥ 输出类型 PCM→DSD（浏览器里＝软解；关掉就没声）
      rememberList: true,       // 记住播放列表（IndexedDB 存音频本体，重载/升级后还在）
      dsdMode: 'passthrough',   // 教程⑥ 转换模式「直通」
      gainMode: 'processing',   // 教程② 播放增益 源模式＝处理
      replayGain: false,        // 教程③ DSP 里不挂任何处理器（含 ReplayGain）
      bufferMs: 1000,           // 教程④ 缓冲长度 1000 毫秒
      exclusive: true,          // 教程⑤ ASIO 独占
      outputDevice: 'auto',     // 教程⑤ 选刚设置好的小尾巴设备
    }

    /** 缓冲长度 → Web Audio 侧更大的 latencyHint，模拟「缓冲够大不卡」 */
    const BUFFER_CHOICES = [200, 500, 1000, 2000]
    function loadSettings() {
      const out = Object.assign({}, DEFAULT_SETTINGS, { eqBands: DEFAULT_SETTINGS.eqBands.slice() })
      try {
        const raw = localStorage.getItem(SETTINGS_KEY)
        if (!raw) return out
        const o = JSON.parse(raw)
        if (o && typeof o === 'object') {
          for (const k of Object.keys(DEFAULT_SETTINGS)) {
            if (o[k] !== undefined && typeof o[k] === typeof DEFAULT_SETTINGS[k]) out[k] = o[k]
          }
          if (Array.isArray(o.eqBands) && o.eqBands.length === 18) out.eqBands = o.eqBands.map((v) => Number.isFinite(+v) ? +v : 0)
        }
      } catch { /* 忽略 */ }
      return out
    }

    // 44.1k 目标采样率：DSD64/128/256 正好是它的 64/128/256 倍，可直接整除抽取
    const DSD_TARGET_RATE = 44100
    const isAudioFile = (f) => {
      if (!f) return false
      const type = String(f.type || '')
      if (type.startsWith('audio/')) return true
      return AUDIO_EXT.test(String(f.name || ''))
    }
    const cheap = (msg) => { try { console?.warn?.('[music-player] ' + msg) } catch { /* 忽略 */ } }

    /* ───────────────────────── 元数据解析 ───────────────────────── */
    // 只读文件头部若干 MB，覆盖绝大多数 ID3 / FLAC 标签（含内嵌封面）。
    const META_READ_LIMIT = 4 * 1024 * 1024
    const be32 = (u8, p) => (((u8[p] << 24) >>> 0) + (u8[p + 1] << 16) + (u8[p + 2] << 8) + u8[p + 3]) >>> 0
    const le32 = (u8, p) => ((u8[p] + (u8[p + 1] << 8) + (u8[p + 2] << 16) + ((u8[p + 3] << 24) >>> 0))) >>> 0
    const syncsafe32 = (u8, p) => (((u8[p] & 0x7f) << 21) + ((u8[p + 1] & 0x7f) << 14) + ((u8[p + 2] & 0x7f) << 7) + (u8[p + 3] & 0x7f)) >>> 0

    function decodeText(u8, start, len, enc) {
      if (!Number.isFinite(len) || len <= 0) return ''
      const view = u8.subarray(start, start + len)
      let out = ''
      try {
        if (enc === 0) out = new TextDecoder('iso-8859-1').decode(view)
        else if (enc === 1) {
          // UTF-16，带 BOM
          if (view[0] === 0xff && view[1] === 0xfe) out = new TextDecoder('utf-16le').decode(view.subarray(2))
          else if (view[0] === 0xfe && view[1] === 0xff) out = new TextDecoder('utf-16be').decode(view.subarray(2))
          else out = new TextDecoder('utf-16le').decode(view)
        } else if (enc === 2) out = new TextDecoder('utf-16be').decode(view)
        else out = new TextDecoder('utf-8').decode(view)
      } catch { out = '' }
      return out.replace(/\u0000+$/g, '').replace(/\u0000/g, '').trim()
    }

    function parseId3(u8) {
      if (u8.length < 10) return null
      if (u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return null // "ID3"
      const ver = u8[3]
      if (ver < 3) return {} // v2.2 帧头不同，先不解析（罕见）
      const flags = u8[5]
      const tagSize = syncsafe32(u8, 6)
      let p = 10
      const end = Math.min(u8.length, 10 + tagSize)
      if (flags & 0x40) { // 扩展头
        if (ver >= 4) p += Math.max(syncsafe32(u8, p), 6)
        else p += 4 + be32(u8, p + 4)
      }
      const out = {}
      while (p + 10 <= end) {
        const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3])
        if (!/^[A-Z0-9]{4}$/.test(id)) break
        const size = ver >= 4 ? syncsafe32(u8, p + 4) : be32(u8, p + 4)
        const dstart = p + 10
        if (dstart + size > end) break
        if (id === 'TIT2' || id === 'TPE1' || id === 'TALB' || id === 'TYER' || id === 'TDRC') {
          const enc = u8[dstart]
          const val = decodeText(u8, dstart + 1, size - 1, enc)
          if (val) {
            if (id === 'TIT2') out.title = val
            else if (id === 'TPE1') out.artist = val
            else if (id === 'TALB') out.album = val
            else out.year = val
          }
        } else if (id === 'APIC') {
          const pic = parseApic(u8, dstart, size)
          if (pic && !out.pic) out.pic = pic
        }
        p = dstart + size
      }
      return out
    }

    function parseApic(u8, dstart, size) {
      try {
        const end = dstart + size
        const enc = u8[dstart]
        let p = dstart + 1
        let mime = ''
        while (p < end && u8[p] !== 0) { mime += String.fromCharCode(u8[p]); p++ }
        p++
        const picType = u8[p]; p++ // 3 = 封面
        if (enc === 1 || enc === 2) {
          while (p + 1 < end && !(u8[p] === 0 && u8[p + 1] === 0)) p += 2
          p += 2
        } else {
          while (p < end && u8[p] !== 0) p++
          p++
        }
        if (p >= end) return null
        const data = u8.subarray(p, end)
        if (!data.length) return null
        return { mime: mime || 'image/jpeg', data, preferred: picType === 3 }
      } catch { return null }
    }

    function parseFlac(u8) {
      if (u8.length < 4) return null
      if (u8[0] !== 0x66 || u8[1] !== 0x4c || u8[2] !== 0x61 || u8[3] !== 0x43) return null // "fLaC"
      let p = 4
      const out = {}
      while (p + 4 <= u8.length) {
        const head = u8[p]
        const isLast = (head & 0x80) !== 0
        const type = head & 0x7f
        const len = (u8[p + 1] << 16) + (u8[p + 2] << 8) + u8[p + 3]
        p += 4
        if (len < 0 || p + len > u8.length) break
        if (type === 4) { // VORBIS_COMMENT
          let q = p
          const vlen = le32(u8, q); q += 4 + vlen
          const count = le32(u8, q); q += 4
          for (let i = 0; i < count && q + 4 <= p + len; i++) {
            const elen = le32(u8, q); q += 4
            if (q + elen > p + len || elen < 0) break
            const line = new TextDecoder('utf-8').decode(u8.subarray(q, q + elen)); q += elen
            const eq = line.indexOf('=')
            if (eq > 0) {
              const k = line.slice(0, eq).toUpperCase()
              const v = line.slice(eq + 1)
              if (k === 'TITLE') out.title = v
              else if (k === 'ARTIST') out.artist = v
              else if (k === 'ALBUM') out.album = v
              else if (k === 'DATE') out.year = v
            }
          }
        } else if (type === 6) { // PICTURE
          let q = p
          const ptype = be32(u8, q); q += 4
          const mlen = be32(u8, q); q += 4
          const mime = new TextDecoder('utf-8').decode(u8.subarray(q, q + mlen)); q += mlen
          const dlen = be32(u8, q); q += 4
          q += dlen // 描述
          q += 16 // 宽/高/色深/索引色数
          const plen = be32(u8, q); q += 4
          const data = u8.subarray(q, q + plen)
          if (data.length && (!out.pic || ptype === 3)) out.pic = { mime: mime || 'image/jpeg', data, preferred: ptype === 3 }
        }
        p += len
        if (isLast) break
      }
      return out
    }

    async function readMetadata(file) {
      try {
        const head = file.slice(0, Math.min(file.size || 0, META_READ_LIMIT))
        const buf = await head.arrayBuffer()
        const u8 = new Uint8Array(buf)
        const id3 = parseId3(u8)
        const flac = id3 && Object.keys(id3).length ? null : parseFlac(u8)
        return id3 || flac || {}
      } catch (err) {
        cheap('读元数据失败：' + String(err?.message ?? err))
        return {}
      }
    }

    const picUrl = (pic) => {
      try { return URL.createObjectURL(new Blob([pic.data], { type: pic.mime || 'image/jpeg' })) } catch { return '' }
    }

    /* ───────────── 播放列表持久化（IndexedDB 存音频本体） ─────────────
     * 问题：刷新页面 / 插件升级重载后，`<input type=file>` 给的 File 对象无法序列化，
     * 播放列表只能存内存，一升级就没了。
     * 方案：把音频文件的 **Blob 本体**存进 IndexedDB（浏览器允许存 Blob），
     * 启动时读回来重建 Blob URL。标签/封面/时长一起存，省得重新解析。
     * 注意：这是「列表备份」，不是云端同步 —— 数据只在本机浏览器里。
     * ───────────────────────────────────────────────────────────────── */
    const DB_NAME = 'dsh-music-player'
    const DB_STORE = 'tracks'
    const DB_VER = 1

    function openDB() {
      return new Promise((resolve) => {
        let db = null
        try {
          if (typeof indexedDB === 'undefined') return resolve(null)
          const req = indexedDB.open(DB_NAME, DB_VER)
          req.onupgradeneeded = () => {
            const d = req.result
            if (!d.objectStoreNames.contains(DB_STORE)) {
              d.createObjectStore(DB_STORE, { keyPath: 'id' })
            }
          }
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => { cheap('IndexedDB 打不开，播放列表不会持久化'); resolve(null) }
          req.onblocked = () => resolve(null)
        } catch (err) {
          cheap('IndexedDB 异常：' + String(err?.message ?? err))
          resolve(null)
        }
      })
    }

    const idbPut = (db, rec) => new Promise((resolve) => {
      try {
        const tx = db.transaction(DB_STORE, 'readwrite')
        tx.objectStore(DB_STORE).put(rec)
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => resolve(false)
        tx.onabort = () => resolve(false)
      } catch { resolve(false) }
    })

    const idbAll = (db) => new Promise((resolve) => {
      try {
        const tx = db.transaction(DB_STORE, 'readonly')
        const req = tx.objectStore(DB_STORE).getAll()
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : [])
        req.onerror = () => resolve([])
      } catch { resolve([]) }
    })

    const idbDel = (db, id) => new Promise((resolve) => {
      try {
        const tx = db.transaction(DB_STORE, 'readwrite')
        tx.objectStore(DB_STORE).delete(id)
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => resolve(false)
      } catch { resolve(false) }
    })

    const idbClear = (db) => new Promise((resolve) => {
      try {
        const tx = db.transaction(DB_STORE, 'readwrite')
        tx.objectStore(DB_STORE).clear()
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => resolve(false)
      } catch { resolve(false) }
    })

    // 上限：别把浏览器存储撑爆（每个源通常 5%~60% 可用空间）
    const PERSIST_MAX_BYTES = 512 * 1024 * 1024

    /* ───────────────────────── 播放引擎（模块级单例） ───────────────────────── */
    let uid = 0
    const ENGINE = {
      audio: null,
      tracks: [],
      index: -1,
      selected: -1, // 单击选中的行（与正在播放的 index 分开）
      playing: false,
      order: 'order', // order | repeat-all | repeat-one | shuffle
      volume: 0.85,
      muted: false,
      time: 0,
      duration: 0,
      filter: '',
      status: '',   // 一句话状态提示（出错/提示）
      settings: null,
      settingsOpen: false,
      wa: null,     // Web Audio 图（均衡器用；只有开了 EQ 才建）
      db: null,     // IndexedDB 句柄
      restoring: false,
      subs: new Set(),

      snap() {
        return {
          tracks: this.tracks,
          index: this.index,
          selected: this.selected,
          playing: this.playing,
          order: this.order,
          volume: this.volume,
          muted: this.muted,
          time: this.time,
          duration: this.duration,
          filter: this.filter,
          status: this.status,
          settings: this.settings,
          settingsOpen: this.settingsOpen,
          eqReady: !!this.wa,
        }
      },
      subscribe(fn) {
        this.subs.add(fn)
        try { fn(this.snap()) } catch { /* 忽略 */ }
        return () => this.subs.delete(fn)
      },
      emit() {
        const s = this.snap()
        for (const fn of this.subs) { try { fn(s) } catch { /* 单个面板出错不影响引擎 */ } }
      },
      setStatus(msg) { this.status = msg || ''; this.emit() },
      setFilter(v) { this.filter = String(v || ''); this.emit() },

      loadPrefs() {
        try {
          const raw = localStorage.getItem(PREF_KEY)
          if (!raw) return
          const o = JSON.parse(raw)
          if (o && typeof o === 'object') {
            if (typeof o.volume === 'number') this.volume = Math.max(0, Math.min(1, o.volume))
            if (typeof o.muted === 'boolean') this.muted = o.muted
            if (['order', 'repeat-all', 'repeat-one', 'shuffle'].includes(o.order)) this.order = o.order
          }
        } catch { /* 忽略 */ }
      },
      savePrefs() {
        try {
          localStorage.setItem(PREF_KEY, JSON.stringify({ volume: this.volume, muted: this.muted, order: this.order }))
        } catch { /* 忽略 */ }
      },

      /* — 持久化：把音频本体 + 标签存进 IndexedDB，重载后能还原 — */
      async initStorage() {
        if (this.db) return this.db
        this.db = await openDB()
        return this.db
      },

      /** 存一首（Blob 本体 + 展示用元数据）。失败不致命，只提示一次。 */
      async persistTrack(track) {
        try {
          const db = await this.initStorage()
          if (!db) return false
          if (!track || !track.file) return false
          if (!this.settings || this.settings.rememberList === false) return false
          if (Number(track.file.size || 0) > PERSIST_MAX_BYTES) {
            this.persistWarned = true
            return false
          }
          const rec = {
            id: track.id,
            name: track.name,
            title: track.title || '',
            artist: track.artist || '',
            album: track.album || '',
            year: track.year || '',
            duration: track.duration || 0,
            blob: track.file,           // Blob 可以直接存
            mime: track.file.type || '',
            fileName: track.file.name || '',
            cover: track.coverBlob || null,
            dsd: !!track.dsd,
            savedAt: Date.now(),
          }
          return await idbPut(db, rec)
        } catch (err) {
          cheap('保存播放列表失败：' + String(err?.message ?? err))
          return false
        }
      },

      async forgetTrack(id) {
        try {
          const db = await this.initStorage()
          if (db) await idbDel(db, id)
        } catch { /* 忽略 */ }
      },

      async forgetAll() {
        try {
          const db = await this.initStorage()
          if (db) await idbClear(db)
        } catch { /* 忽略 */ }
      },

      /** 启动时把上次的列表读回来（Blob → 新的 Blob URL） */
      async restoreTracks() {
        if (this.restoring) return 0
        this.restoring = true
        try {
          const db = await this.initStorage()
          if (!db) return 0
          const recs = (await idbAll(db)).sort((a, b) => (a.id || 0) - (b.id || 0))
          if (!recs.length) return 0
          const restored = []
          for (const r of recs) {
            if (!r || !r.blob) continue
            let url = ''
            try { url = URL.createObjectURL(r.blob) } catch { continue }
            const track = {
              id: typeof r.id === 'number' ? r.id : ++uid,
              file: r.blob,
              url,
              dsd: !!r.dsd,
              decoding: false,
              dsdDecoded: !!r.dsd,
              name: r.name || r.fileName || '音频',
              title: r.title || '',
              artist: r.artist || '',
              album: r.album || '',
              year: r.year || '',
              duration: r.duration || 0,
              realDuration: r.duration || 0,
              coverUrl: '',
              coverBlob: r.cover || null,
              loading: false,
            }
            if (track.id > uid) uid = track.id
            if (r.cover) {
              try { track.coverUrl = URL.createObjectURL(r.cover) } catch { /* 忽略 */ }
            }
            restored.push(track)
          }
          if (!restored.length) return 0
          // 已有的（本次会话新加的）排在后面，避免覆盖
          this.tracks = restored.concat(this.tracks)
          if (this.index < 0 && this.tracks.length) {
            this.index = 0
            this.selected = 0
            const t = this.tracks[0]
            this.duration = t.duration || 0
            const a = this.ensureAudio()
            if (a) { try { a.src = t.url; a.load() } catch { /* 忽略 */ } }
          }
          this.status = ''
          this.emit()
          return restored.length
        } catch (err) {
          cheap('恢复播放列表失败：' + String(err?.message ?? err))
          return 0
        } finally {
          this.restoring = false
        }
      },

      loadSettings() { this.settings = loadSettings() },
      saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)) } catch { /* 忽略 */ }
      },
      setSettings(patch) {
        if (!this.settings) this.loadSettings()
        this.settings = Object.assign({}, this.settings, patch || {})
        this.saveSettings()
        // 关掉「记住播放列表」时，把已存的也清掉，避免下次又冒出来
        if (patch && patch.rememberList === false) { try { this.forgetAll() } catch { /* 忽略 */ } }
        this.applyEQ()
        this.emit()
      },
      resetSettings() {
        this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
        this.saveSettings()
        this.applyEQ()
        this.emit()
      },
      setSettingsOpen(v) { this.settingsOpen = !!v; this.emit() },
      setOrder(key) {
        if (!['order', 'repeat-all', 'repeat-one', 'shuffle'].includes(key)) return
        this.order = key
        this.savePrefs()
        this.emit()
      },

      /**
       * 建 Web Audio 图：audio 元素 → 预增益 → 18 段 peaking biquad → 输出。
       * 只有「开均衡器」时才建；建过一次后音频就固定走这张图，关闭 EQ 只是把
       * 所有增益归 0（MediaElementSource 无法撤回到直连）。
       */
      ensureWebAudio() {
        if (this.wa) return this.wa
        if (typeof window === 'undefined') return null
        const AC = window.AudioContext || window.webkitAudioContext
        if (!AC) return null
        try {
          const a = this.ensureAudio()
          if (!a) return null
          // 缓冲长度（教程④ 1000ms）→ latencyHint，让浏览器自己把缓冲拉大
          const buf = Number(this.settings && this.settings.bufferMs) || 1000
          const hint = buf >= 1000 ? 'playback' : (buf <= 200 ? 'interactive' : 'balanced')
          let ac
          try { ac = new AC({ latencyHint: hint }) } catch { ac = new AC() }
          const pre = ac.createGain()
          const bands = EQ_FREQS.map((f) => {
            const n = ac.createBiquadFilter()
            n.type = 'peaking'
            n.frequency.value = f
            n.Q.value = 1.1
            n.gain.value = 0
            return n
          })
          // 先把 pre → 18 段 → 输出 接好，最后才动 MediaElementSource：
          // 它一旦建成就把元素音频改道，所以放到最后，失败也不会变哑巴。
          // 先把 pre → 18 段 → 输出 接好，最后才动 MediaElementSource：
          // 它一旦建成就把元素音频改道，所以放到最后，失败也不会变哑巴。
          let node = pre
          for (const b of bands) { node.connect(b); node = b }
          node.connect(ac.destination)
          const src = ac.createMediaElementSource(a)
          src.connect(pre)
          this.wa = { ac, src, pre, bands }
          return this.wa
        } catch (err) {
          cheap('Web Audio 初始化失败：' + String(err?.message ?? err))
          return null
        }
      },
      applyEQ() {
        try {
          const st = this.settings
          if (!st) return
          if (!st.eqEnabled) {
            if (this.wa) {
              this.wa.pre.gain.value = 1
              for (const b of this.wa.bands) b.gain.value = 0
            }
            return
          }
          const wa = this.ensureWebAudio()
          if (!wa) { this.setStatus('这台浏览器不支持 Web Audio，均衡器用不了'); return }
          const preampDb = Number(st.eqPreamp) || 0
          wa.pre.gain.value = Math.pow(10, preampDb / 20)
          for (let i = 0; i < wa.bands.length; i++) {
            wa.bands[i].gain.value = Number((st.eqBands && st.eqBands[i]) || 0)
          }
        } catch (err) { cheap('EQ 应用失败：' + String(err?.message ?? err)) }
      },
      resumeWA() {
        try { if (this.wa && this.wa.ac.state === 'suspended') { const p = this.wa.ac.resume(); if (p && p.catch) p.catch(() => {}) } } catch { /* 忽略 */ }
      },

      ensureAudio() {
        if (this.audio) return this.audio
        try {
          const a = new Audio()
          a.preload = 'metadata'
          a.volume = this.volume
          a.muted = this.muted
          a.addEventListener('timeupdate', () => { this.time = a.currentTime || 0; this.emit() })
          a.addEventListener('loadedmetadata', () => {
            if (isFinite(a.duration) && a.duration > 0) {
              this.duration = a.duration
              const t = this.tracks[this.index]
              if (t && !t.realDuration) t.realDuration = a.duration
            }
            this.emit()
          })
          a.addEventListener('play', () => { this.playing = true; this.resumeWA(); this.emit() })
          a.addEventListener('pause', () => { this.playing = false; this.emit() })
          a.addEventListener('ended', () => this.onEnded())
          a.addEventListener('error', () => {
            const a2 = this.audio
            if (a2 && a2.error) cheap('音频错误：' + a2.error.code)
            this.setStatus('这首放不了（浏览器不支持该格式或文件损坏）')
            this.playing = false
            this.emit()
          })
          this.audio = a
        } catch (err) {
          cheap('创建 Audio 失败：' + String(err?.message ?? err))
        }
        return this.audio
      },

      /* — 播放列表 — */
      async addFiles(fileList) {
        const files = Array.from(fileList || []).filter(isAudioFile)
        if (!files.length) {
          if (fileList && fileList.length) this.setStatus('这些文件不是音频（按扩展名/类型过滤掉了）')
          return 0
        }
        const added = []
        const st = this.settings || DEFAULT_SETTINGS
        for (const file of files) {
          const dsd = DSD_EXT.test(String(file.name || ''))
          let url = ''
          if (!dsd) {
            try { url = URL.createObjectURL(file) } catch { continue }
          }
          const track = {
            id: ++uid,
            file,
            url,
            dsd,
            decoding: dsd && !!st.dsdDecode,
            dsdDecoded: false,
            name: String(file.name || '').replace(/\.[^.]+$/, '') || `音频 ${uid}`,
            title: '',
            artist: '',
            album: '',
            year: '',
            duration: 0,
            realDuration: 0,
            coverUrl: '',
            loading: true,
          }
          added.push(track)
        }
        if (!added.length) { this.setStatus('添加失败：这些文件读不了'); return 0 }
        this.tracks = this.tracks.concat(added)
        this.status = added.some((t) => t.dsd && !t.decoding)
          ? 'DSD 软解已关闭：DSF/DFF 不能直接播放（设置里可打开）'
          : ''
        this.emit()

        // 元数据 + 封面（异步；读完刷新一次）
        for (const track of added) {
          if (track.dsd || !st.readTags) { track.loading = false; this.persistTrack(track); continue }
          readMetadata(track.file).then((meta) => {
            try {
              if (meta.title) track.title = meta.title
              if (meta.artist) track.artist = meta.artist
              if (meta.album) track.album = meta.album
              if (meta.year) track.year = meta.year
              if (meta.pic && meta.pic.data && meta.pic.data.length && st.readCover) {
                track.coverBlob = new Blob([meta.pic.data], { type: meta.pic.mime || 'image/jpeg' })
                track.coverUrl = picUrl(meta.pic)
              }
            } catch { /* 忽略 */ }
            track.loading = false
            // 标签读完了再存，重载后不用重新解析一遍
            this.persistTrack(track)
            this.emit()
          }).catch(() => { track.loading = false; this.persistTrack(track); this.emit() })
        }

        // DSD：软解成 44.1k PCM → WAV Blob，再喂给同一个 audio 元素
        for (const track of added) {
          if (!track.dsd || !track.decoding) continue
          decodeDsdFile(track.file).then(({ url: wavUrl, duration }) => {
            if (!this.tracks.includes(track)) { try { URL.revokeObjectURL(wavUrl) } catch { /* 忽略 */ } return }
            track.url = wavUrl
            track.decoding = false
            track.dsdDecoded = true
            if (duration > 0) track.duration = duration
            // DSD 存的是**原始文件**，重载后再软解一次（WAV 太大，不值得存）
            this.persistTrack(track)
            if (this.index < 0) {
              const idx = this.tracks.indexOf(track)
              if (idx >= 0) this.load(idx, false)
            }
            this.emit()
          }).catch((err) => {
            track.decoding = false
            track.loading = false
            this.setStatus('DSD 转 PCM 失败：' + String(err?.message ?? err))
          })
        }

        // 时长（异步探测，惰性队列；DSD 等解码完再探）
        this.probeAll(added.filter((t) => t.url))

        // 时长探到后再补存一次（这样重载后列表直接显示时长）
        setTimeout(() => {
          for (const t of added) if (t.duration > 0) this.persistTrack(t)
        }, 8000)

        // 本来是空列表：选中第一首（不自动播放，避免自动播放策略拦截）
        if (this.index < 0) {
          const first = added.find((t) => t.url && !t.dsd) || added.find((t) => t.url)
          const idx = first ? this.tracks.indexOf(first) : -1
          if (idx >= 0) this.load(idx, false)
        }
        return added.length
      },

      probeAll(list) {
        const queue = list.slice()
        let active = 0
        const pump = () => {
          while (active < 3 && queue.length) {
            const track = queue.shift()
            if (!track) continue
            active++
            probeDuration(track.url).then((d) => {
              if (d > 0) { track.duration = d; this.emit() }
            }).finally(() => { active--; pump() })
          }
        }
        pump()
      },

      revoke(track) {
        if (!track) return
        try { if (track.url) URL.revokeObjectURL(track.url) } catch { /* 忽略 */ }
        try { if (track.coverUrl) URL.revokeObjectURL(track.coverUrl) } catch { /* 忽略 */ }
      },

      removeAt(i) {
        const t = this.tracks[i]
        if (!t) return
        this.revoke(t)
        this.forgetTrack(t.id)     // 从持久化里也删掉
        const wasCurrent = i === this.index
        const next = this.tracks.slice()
        next.splice(i, 1)
        this.tracks = next
        if (!next.length) {
          this.hardStop()
          this.index = -1
          this.selected = -1
          this.time = 0
          this.duration = 0
        } else if (wasCurrent) {
          this.hardStop()
          this.index = Math.min(i, next.length - 1)
          this.selected = this.index
          this.load(this.index, false)
        } else if (i < this.index) {
          this.index -= 1
        }
        if (this.selected >= this.tracks.length) this.selected = this.tracks.length - 1
        this.emit()
      },

      clear() {
        for (const t of this.tracks) this.revoke(t)
        this.tracks = []
        this.hardStop()
        this.forgetAll()           // 清空持久化，重载后不会又冒出来
        this.index = -1
        this.selected = -1
        this.time = 0
        this.duration = 0
        this.playing = false
        this.status = ''
        this.emit()
      },

      hardStop() {
        const a = this.audio
        if (!a) return
        try {
          a.pause()
          a.removeAttribute('src')
          a.load()
        } catch { /* 忽略 */ }
      },

      load(i, autoplay) {
        const t = this.tracks[i]
        if (!t) return
        const a = this.ensureAudio()
        if (!a) return
        this.index = i
        this.selected = i
        this.time = 0
        this.duration = t.duration || t.realDuration || 0
        try {
          a.src = t.url
          a.load()
        } catch (err) { cheap('加载音频失败：' + String(err?.message ?? err)) }
        if (autoplay) this.play()
        this.emit()
      },

      play() {
        const a = this.ensureAudio()
        if (!a) return
        if (this.index < 0 && this.tracks.length) { this.load(0, true); return }
        try {
          if (this.settings && this.settings.eqEnabled) this.applyEQ()
          this.resumeWA()
          const p = a.play()
          if (p && typeof p.catch === 'function') p.catch(() => { this.playing = false; this.emit() })
        } catch (err) { cheap('play 失败：' + String(err?.message ?? err)) }
      },

      pause() {
        const a = this.audio
        if (!a) return
        try { a.pause() } catch { /* 忽略 */ }
      },

      toggle() {
        if (this.playing) this.pause()
        else this.play()
      },

      stop() {
        const a = this.audio
        if (!a) return
        const reset = !this.settings || this.settings.stopResets !== false
        try { a.pause(); if (reset) a.currentTime = 0 } catch { /* 忽略 */ }
        if (reset) this.time = 0
        this.playing = false
        this.emit()
      },

      /** 一首放完：按设置决定自动下一首还是停住 */
      onEnded() {
        if (!this.settings || this.settings.autoNext !== false) { this.next(true); return }
        const a = this.audio
        if (a) { try { a.pause() } catch { /* 忽略 */ } }
        this.playing = false
        this.emit()
      },

      next(auto) {
        const n = this.tracks.length
        if (!n) return
        let idx = this.index
        if (auto && this.order === 'repeat-one') {
          idx = this.index
        } else if (this.order === 'shuffle') {
          if (n === 1) idx = 0
          else { do { idx = Math.floor(Math.random() * n) } while (idx === this.index) }
        } else {
          idx = this.index + 1
          if (idx >= n) {
            if (auto && this.order === 'order') { this.stop(); return }
            idx = 0
          }
        }
        this.load(idx, true)
      },

      prev() {
        const n = this.tracks.length
        if (!n) return
        let idx = this.index - 1
        if (idx < 0) idx = n - 1
        this.load(idx, true)
      },

      /** 单击：只选中（不播放），方便看清是哪首 */
      selectAt(i) {
        if (!this.tracks[i]) return
        if (i === this.index) return
        this.selected = i
        this.emit()
      },

      /** 双击：播放这一首（已在放就从头重放） */
      playAt(i) {
        if (!this.tracks[i]) return
        this.selected = i
        if (i === this.index) {
          if (this.playing) { this.seek(0); return }
          this.load(i, true)
        } else {
          this.load(i, true)
        }
      },

      seek(t) {
        const a = this.audio
        if (!a) return
        try { a.currentTime = Math.max(0, Number(t) || 0) } catch { /* 忽略 */ }
      },

      setVolume(v) {
        const nv = Math.max(0, Math.min(1, Number(v) || 0))
        this.volume = nv
        if (this.audio) { try { this.audio.volume = nv } catch { /* 忽略 */ } }
        if (nv > 0 && this.muted) { this.muted = false; if (this.audio) try { this.audio.muted = false } catch { /* 忽略 */ } }
        this.savePrefs()
        this.emit()
      },

      toggleMute() {
        this.muted = !this.muted
        if (this.audio) { try { this.audio.muted = this.muted } catch { /* 忽略 */ } }
        this.savePrefs()
        this.emit()
      },

      cycleOrder() {
        const list = ['order', 'repeat-all', 'repeat-one', 'shuffle']
        this.order = list[(list.indexOf(this.order) + 1) % list.length]
        this.savePrefs()
        this.emit()
      },
    }

    function probeDuration(url) {
      return new Promise((resolve) => {
        let done = false
        let timer = 0
        const finish = (v) => {
          if (done) return
          done = true
          try { clearTimeout(timer) } catch { /* 忽略 */ }
          resolve(v)
        }
        try {
          const a = new Audio()
          a.preload = 'metadata'
          a.addEventListener('loadedmetadata', () => finish(isFinite(a.duration) && a.duration > 0 ? a.duration : 0))
          a.addEventListener('error', () => finish(0))
          timer = setTimeout(() => finish(0), 12000)
          a.src = url
        } catch { finish(0) }
      })
    }

    /* ─────────── DSD 软解：DSF / DFF(未压缩) → 44.1k PCM → WAV ───────────
     * 浏览器没有 ASIO/DoP，做不到 foobar + foo_input_sacd 那种「硬解」，
     * 但可以像 foo_input_sacd 的默认模式一样**软解成 PCM**再放：
     *   1-bit × ratio 个比特取平均（box 抽取）得到 44.1k 样本；
     *   2) 二阶低通压掉 DSD 的高频噪声整形；
     *   3) 打成 WAV Blob，喂给同一个 <audio>。
     * DSD64/128/256 = 44100 的 64/128/256 倍，正好整除。
     * ───────────────────────────────────────────────────────────────────── */
    const POPCOUNT = (() => {
      const t = new Uint8Array(256)
      for (let i = 0; i < 256; i++) { let v = i, c = 0; while (v) { c += v & 1; v >>= 1 } t[i] = c }
      return t
    })()
    const u16le = (u8, p) => u8[p] | (u8[p + 1] << 8)
    const u32le = (u8, p) => (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0
    const u64le = (u8, p) => u32le(u8, p) + u32le(u8, p + 4) * 4294967296
    const u16be = (u8, p) => (u8[p] << 8) | u8[p + 1]
    const u32be = (u8, p) => ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0
    const u64be = (u8, p) => u32be(u8, p) * 4294967296 + u32be(u8, p + 4)
    const ascii4 = (u8, p) => String.fromCharCode(u8[p] || 0, u8[p + 1] || 0, u8[p + 2] || 0, u8[p + 3] || 0)

    function lowpassCoeffs(fs, fc, q) {
      const w0 = (2 * Math.PI * fc) / fs
      const alpha = Math.sin(w0) / (2 * q)
      const cw = Math.cos(w0)
      const a0 = 1 + alpha
      return {
        b0: ((1 - cw) / 2) / a0,
        b1: (1 - cw) / a0,
        b2: ((1 - cw) / 2) / a0,
        a1: (-2 * cw) / a0,
        a2: (1 - alpha) / a0,
      }
    }

    /** 把「每采样 ratio 个 1-bit」抽成 16-bit PCM；readByte(ch, logicalByteIndex) 负责取字节 */
    function dsdBitsToPcm(readByte, channels, ratio, frames) {
      const bytesPerFrame = ratio / 8
      const out = new Int16Array(frames * channels)
      const co = lowpassCoeffs(DSD_TARGET_RATE, 19500, 0.707)
      const st = []
      for (let c = 0; c < channels; c++) st.push({ x1: 0, x2: 0, y1: 0, y2: 0 })
      const inv = 2 / ratio
      for (let c = 0; c < channels; c++) {
        const s = st[c]
        for (let f = 0; f < frames; f++) {
          let sum = 0
          const base = f * bytesPerFrame
          for (let j = 0; j < bytesPerFrame; j++) sum += POPCOUNT[readByte(c, base + j)]
          const x0 = sum * inv - 1 // 1 → +1, 0 → -1
          const y0 = co.b0 * x0 + co.b1 * s.x1 + co.b2 * s.x2 - co.a1 * s.y1 - co.a2 * s.y2
          s.x2 = s.x1; s.x1 = x0; s.y2 = s.y1; s.y1 = y0
          out[f * channels + c] = Math.max(-32768, Math.min(32767, Math.round(y0 * 32767)))
        }
      }
      return out
    }

    /** DSF：块内按通道排（每通道 blockSize 字节），位序 LSB-first */
    function decodeDsf(u8) {
      if (ascii4(u8, 0) !== 'DSD ') throw new Error('不是 DSF 文件')
      if (ascii4(u8, 28) !== 'fmt ') throw new Error('DSF 缺 fmt 块')
      const channels = u32le(u8, 52) || 2
      const rate = u32le(u8, 56) || 2822400
      const sampleCount = u64le(u8, 64)
      const blockSize = u32le(u8, 72) || 4096
      if (ascii4(u8, 80) !== 'data') throw new Error('DSF 缺 data 块')
      const dataStart = 92
      const ratio = Math.round(rate / DSD_TARGET_RATE)
      if (!(ratio >= 8 && ratio % 8 === 0)) throw new Error('DSD 采样率不支持：' + rate)
      const bytesPerFrame = ratio / 8
      const framesPerBlock = Math.floor(blockSize / bytesPerFrame)
      const availBlocks = Math.floor((u8.length - dataStart) / (channels * blockSize))
      const byCount = Math.floor(sampleCount / ratio)
      const frames = byCount > 0 ? Math.min(byCount, availBlocks * framesPerBlock) : availBlocks * framesPerBlock
      if (!(frames > 0)) throw new Error('DSF 里没有可解码的数据')
      const readByte = (ch, logical) => {
        const block = Math.floor(logical / blockSize)
        const off = logical - block * blockSize
        return u8[dataStart + (block * channels + ch) * blockSize + off] || 0
      }
      return { channels, rate: DSD_TARGET_RATE, frames, pcm: dsdBitsToPcm(readByte, channels, ratio, frames) }
    }

    /** DFF（DSDIFF）：字节按声道交错，位序 MSB-first；DST 压缩不支持 */
    function decodeDff(u8) {
      if (ascii4(u8, 0) !== 'FRM8') throw new Error('不是 DFF 文件')
      let rate = 0
      let channels = 2
      let dataStart = 0
      let dataEnd = 0
      // FRM8 头：'FRM8'(4) + 长度(8) + 形态类型 'DSD '(4)，块从 16 开始
      let p = 16
      while (p + 12 <= u8.length) {
        const id = ascii4(u8, p)
        const size = u64be(u8, p + 4)
        const start = p + 12
        const end = Math.min(u8.length, start + size)
        if (id === 'PROP') {
          let q = start + 4 // 'SND ' form type
          while (q + 12 <= end) {
            const sid = ascii4(u8, q)
            const ssize = u64be(u8, q + 4)
            const sstart = q + 12
            const send = Math.min(end, sstart + ssize)
            if (sid === 'FS  ') rate = u32be(u8, sstart)
            else if (sid === 'CHNL') channels = u16be(u8, sstart) || 2
            else if (sid === 'CMPR') {
              const cmp = ascii4(u8, sstart)
              if (cmp === 'DST ') throw new Error('DFF 用了 DST 压缩，浏览器解不了（换未压缩 DFF 或 DSF）')
            }
            if (send <= sstart) break
            q = send + (send % 2)
          }
        } else if (id === 'DSD ') { dataStart = start; dataEnd = end }
        if (end <= p) break
        p = end + (end % 2)
      }
      if (!dataStart || !dataEnd) throw new Error('DFF 里没有 DSD 数据块')
      if (!rate) throw new Error('DFF 缺采样率')
      const ratio = Math.round(rate / DSD_TARGET_RATE)
      if (!(ratio >= 8 && ratio % 8 === 0)) throw new Error('DSD 采样率不支持：' + rate)
      const bytesPerFrame = ratio / 8
      const frames = Math.floor((dataEnd - dataStart) / (bytesPerFrame * channels))
      if (!(frames > 0)) throw new Error('DFF 里没有可解码的数据')
      const readByte = (ch, logical) => u8[dataStart + logical * channels + ch] || 0
      return { channels, rate: DSD_TARGET_RATE, frames, pcm: dsdBitsToPcm(readByte, channels, ratio, frames) }
    }

    function pcmToWav(pcm, channels, rate) {
      const dataSize = pcm.length * 2
      const buf = new ArrayBuffer(44 + dataSize)
      const dv = new DataView(buf)
      const wr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)) }
      wr(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); wr(8, 'WAVE')
      wr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, channels, true)
      dv.setUint32(24, rate, true); dv.setUint32(28, rate * channels * 2, true)
      dv.setUint16(32, channels * 2, true); dv.setUint16(34, 16, true)
      wr(36, 'data'); dv.setUint32(40, dataSize, true)
      new Int16Array(buf, 44).set(pcm)
      return buf
    }

    function decodeDsdBuffer(buf) {
      const u8 = new Uint8Array(buf)
      const magic = ascii4(u8, 0)
      if (magic === 'DSD ') return decodeDsf(u8)
      if (magic === 'FRM8') return decodeDff(u8)
      throw new Error('不是 DSD 文件（只认 DSF / DFF）')
    }

    async function decodeDsdFile(file) {
      if (!file || typeof file.arrayBuffer !== 'function') throw new Error('读不了这个文件')
      // DSD 整首读进内存再转：超大文件先拦住，别把标签页撑爆
      if (Number(file.size) > 768 * 1024 * 1024) throw new Error('DSD 文件太大（>768MB），建议先转成 PCM/FLAC 再放')
      const ab = await file.arrayBuffer()
      const res = decodeDsdBuffer(ab)
      const wav = pcmToWav(res.pcm, res.channels, res.rate)
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
      return { url, duration: res.frames / res.rate, channels: res.channels }
    }

    ENGINE.loadPrefs()
    ENGINE.loadSettings()

    // 把上次的播放列表从 IndexedDB 读回来（刷新页面 / 插件升级后不会丢歌）
    try {
      if (typeof indexedDB !== 'undefined') {
        ENGINE.initStorage().then(() => ENGINE.restoreTracks()).catch(() => {})
      }
    } catch { /* 忽略 */ }

    // 调试钩子：冒烟脚本在 Node 里 mock 掉 window/document/Audio/React 后，
    // 直接驱动引擎验证加歌 / 解析 / 播放 / 顺序模式 / DSD 解码。浏览器里只是只读引用。
    try {
      if (typeof window !== 'undefined') {
        window.__musicPlayerEngine = ENGINE
        window.__musicPlayerDebug = { decodeDsdBuffer, decodeDsf, decodeDff, pcmToWav, EQ_PRESETS, EQ_FREQS, DEFAULT_SETTINGS, BUFFER_CHOICES }
      }
    } catch { /* 忽略 */ }

    /* ───────────────────────── 图标 ───────────────────────── */
    const svg = (children, props) => h('svg', Object.assign({
      width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true',
    }, props || {}), children)

    const Icon = {
      play: () => svg(h('path', { d: 'M8 5.5v13L19 12z', fill: 'currentColor', stroke: 'none' })),
      pause: () => svg([
        h('rect', { key: 'a', x: 7, y: 5, width: 3.4, height: 14, rx: 1, fill: 'currentColor', stroke: 'none' }),
        h('rect', { key: 'b', x: 13.6, y: 5, width: 3.4, height: 14, rx: 1, fill: 'currentColor', stroke: 'none' }),
      ]),
      prev: () => svg([
        h('path', { key: 'a', d: 'M18 6v12L8.5 12z', fill: 'currentColor', stroke: 'none' }),
        h('rect', { key: 'b', x: 5, y: 5.5, width: 2.2, height: 13, rx: 1, fill: 'currentColor', stroke: 'none' }),
      ]),
      next: () => svg([
        h('path', { key: 'a', d: 'M6 6v12l9.5-6z', fill: 'currentColor', stroke: 'none' }),
        h('rect', { key: 'b', x: 16.8, y: 5.5, width: 2.2, height: 13, rx: 1, fill: 'currentColor', stroke: 'none' }),
      ]),
      stop: () => svg(h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2.4, fill: 'currentColor', stroke: 'none' })),
      plus: () => svg(h('path', { d: 'M12 5v14M5 12h14' })),
      trash: () => svg([
        h('path', { key: 'a', d: 'M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 12a1 1 0 001 1h8a1 1 0 001-1l1-12' }),
      ]),
      order: () => svg([
        h('path', { key: 'a', d: 'M4 7h10M4 12h7M4 17h10' }),
        h('path', { key: 'b', d: 'M18 5v14l4-3.5' }),
      ]),
      'repeat-all': () => svg([
        h('path', { key: 'a', d: 'M17 2.5l3.5 3.5L17 9.5' }),
        h('path', { key: 'b', d: 'M3.5 11.5V10a4 4 0 014-4h13' }),
        h('path', { key: 'c', d: 'M7 21.5L3.5 18 7 14.5' }),
        h('path', { key: 'd', d: 'M20.5 12.5V14a4 4 0 01-4 4h-13' }),
      ]),
      'repeat-one': () => svg([
        h('path', { key: 'a', d: 'M17 2.5l3.5 3.5L17 9.5' }),
        h('path', { key: 'b', d: 'M3.5 11.5V10a4 4 0 014-4h13' }),
        h('path', { key: 'c', d: 'M7 21.5L3.5 18 7 14.5' }),
        h('path', { key: 'd', d: 'M20.5 12.5V14a4 4 0 01-4 4h-13' }),
        h('path', { key: 'e', d: 'M11.5 10.5l1.6-1v5' }),
      ]),
      shuffle: () => svg([
        h('path', { key: 'a', d: 'M16 3h5v5M21 16v5h-5' }),
        h('path', { key: 'b', d: 'M4 20L21 3M15 15l6 6M4 4l5 5' }),
      ]),
      volume: ({ muted } = {}) => svg([
        h('path', { key: 'a', d: 'M4 9.5h3.2L12 5.5v13l-4.8-4H4z' }),
        muted
          ? h('path', { key: 'b', d: 'M16 9.5l4 5M20 9.5l-4 5' })
          : [h('path', { key: 'b', d: 'M15.5 9a4.2 4.2 0 010 6' }), h('path', { key: 'c', d: 'M18.2 6.6a7.6 7.6 0 010 10.8' })],
      ]),
      search: () => svg([h('circle', { key: 'a', cx: 10.5, cy: 10.5, r: 6.5 }), h('path', { key: 'b', d: 'M15.5 15.5L21 21' })]),
      music: () => svg([
        h('path', { key: 'a', d: 'M9 18V5.5l10-2.4V16' }),
        h('circle', { key: 'b', cx: 6.6, cy: 18.2, r: 2.6 }),
        h('circle', { key: 'c', cx: 16.6, cy: 16.1, r: 2.6 }),
      ]),
      gear: () => svg([
        h('circle', { key: 'a', cx: 12, cy: 12, r: 3.1 }),
        h('path', { key: 'b', d: 'M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1.03 1.56V21a2 2 0 11-4 0v-.09A1.7 1.7 0 009 19.4a1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-1.56-1.03H3a2 2 0 110-4h.09A1.7 1.7 0 004.6 9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 009 4.6h.09A1.7 1.7 0 0010.09 3V3a2 2 0 114 0v.09A1.7 1.7 0 0015.09 4.6h.09a1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.4 9v.09A1.7 1.7 0 0021 10.09H21a2 2 0 110 4h-.09A1.7 1.7 0 0019.4 15z' }),
      ]),
      back: () => svg(h('path', { d: 'M15 5l-7 7 7 7' })),
    }

    const ORDER_META = {
      'order': { label: '顺序播放', icon: Icon.order },
      'repeat-all': { label: '列表循环', icon: Icon['repeat-all'] },
      'repeat-one': { label: '单曲循环', icon: Icon['repeat-one'] },
      'shuffle': { label: '随机播放', icon: Icon.shuffle },
    }

    /* ───────────────────────── 样式 ───────────────────────── */
    const CSS = `
[data-mp]{display:flex;flex-direction:column;height:100%;min-height:0;gap:10px;padding:12px 16px 8px;
  color:var(--dsw-alias-label-primary,#e8eaed);box-sizing:border-box;font:inherit;}
[data-mp-head]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none;}
[data-mp-logo]{width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;
  background:rgba(59,130,246,.16);color:var(--dsw-alias-brand-primary,#3b82f6);}
[data-mp-title]{font-size:15px;font-weight:700;letter-spacing:.01em;}
[data-mp-sub]{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-mp-grow]{flex:1;}
[data-mp-searchwrap]{display:flex;align-items:center;gap:6px;height:28px;padding:0 9px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:transparent;
  color:var(--dsw-alias-label-secondary,#9aa0a6);min-width:150px;}
[data-mp-searchwrap]:focus-within{border-color:var(--dsw-alias-brand-primary,#3b82f6);}
[data-mp-search]{flex:1;min-width:0;border:0;background:transparent;color:inherit;font-size:12px;font-family:inherit;outline:none;}
[data-mp-btn]{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;font-size:12px;border-radius:8px;
  cursor:pointer;color:inherit;font-family:inherit;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));
  background:transparent;}
[data-mp-btn]:hover:not(:disabled){background:rgba(127,127,127,.12);}
[data-mp-btn]:disabled{opacity:.45;cursor:default;}
/* ⚠️ 主按钮**不能**用 --dsw-alias-brand-primary 当底色：深色主题里那个 token 本身是白色
   （宿主的主按钮＝白底黑字），照抄就得到一片白。
   而且 [data-mp-btn]:hover:not(:disabled) 的优先级(0,3,0) 会压过 [data-mp-btn][data-primary](0,2,0)，
   所以静止时白底、悬停反而变灰——这就是「不放上去是白色」的真相。
   这里：① 固定蓝；② 提高选择器优先级；③ !important 兜底，谁也别想盖。 */
[data-mp] [data-mp-btn][data-primary]{
  background:#2f6fed !important;border:1px solid #2f6fed !important;
  color:#fff !important;font-weight:600;}
[data-mp] [data-mp-btn][data-primary]:hover:not(:disabled){
  background:#3b82f6 !important;border-color:#3b82f6 !important;color:#fff !important;}
[data-mp] [data-mp-btn][data-primary]:focus-visible{
  background:#2f6fed !important;color:#fff !important;outline:2px solid #93b8ff;outline-offset:1px;}
[data-mp-body]{flex:1;min-height:0;display:flex;gap:12px;}
[data-mp-listcol]{flex:1;min-width:0;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));
  border-radius:10px;overflow:hidden;background:rgba(127,127,127,.04);}
[data-mp-list]{flex:1;min-height:0;overflow:auto;}
[data-mp-row]{display:flex;align-items:center;gap:9px;padding:6px 10px;font-size:12px;cursor:pointer;min-height:34px;
  border-bottom:1px solid rgba(127,127,127,.07);}
[data-mp-row]:last-child{border-bottom:0;}
[data-mp-row]:hover:not([data-on]){background:rgba(127,127,127,.10);}
[data-mp-row][data-sel]:not([data-on]){background:rgba(127,127,127,.16);}
[data-mp-row][data-on]{background:rgba(59,130,246,.15);}
[data-mp-row][data-on] [data-mp-name]{color:var(--dsw-alias-brand-primary,#60a5fa);font-weight:600;}
[data-mp-idx]{width:24px;flex:none;text-align:right;font-size:10.5px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-mp-row][data-on] [data-mp-idx]{color:var(--dsw-alias-brand-primary,#60a5fa);}
[data-mp-info]{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
[data-mp-name]{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-mp-artist]{font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa0a6);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-mp-dur]{width:44px;flex:none;text-align:right;font-size:10.5px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-mp-rm]{flex:none;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border:0;
  border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);cursor:pointer;opacity:0;}
[data-mp-row]:hover [data-mp-rm]{opacity:1;}
[data-mp-rm]:hover{color:var(--dsw-alias-state-error-primary,#ef4444);background:rgba(239,68,68,.12);}
[data-mp-empty]{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
  color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:12px;text-align:center;padding:20px;}
[data-mp-side]{width:232px;flex:none;display:flex;flex-direction:column;gap:10px;min-height:0;}
[data-mp-cover]{width:100%;aspect-ratio:1/1;max-height:228px;border-radius:10px;overflow:hidden;flex:none;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:rgba(127,127,127,.10);
  display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-mp-cover] img{width:100%;height:100%;object-fit:cover;display:block;}
[data-mp-nowinfo]{display:flex;flex-direction:column;gap:3px;min-width:0;}
[data-mp-nowtitle]{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-mp-nowartist]{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0a6);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-mp-bar]{flex:none;display:flex;flex-direction:column;gap:7px;padding-top:2px;}
[data-mp-seekrow]{display:flex;align-items:center;gap:9px;font-size:10.5px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-mp-seek]{flex:1;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary,#3b82f6);cursor:pointer;}
[data-mp-ctrl]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-mp-ibtn]{width:30px;height:30px;display:flex;align-items:center;justify-content:center;border:0;border-radius:8px;
  background:transparent;color:inherit;cursor:pointer;}
[data-mp-ibtn]:hover:not(:disabled){background:rgba(127,127,127,.14);}
[data-mp-ibtn]:disabled{opacity:.4;cursor:default;}
[data-mp-ibtn][data-active]{color:var(--dsw-alias-brand-primary,#60a5fa);}
/* 同上：播放圆钮也用固定蓝 + !important，避免深色主题取到白色 token、被 hover 灰盖掉 */
[data-mp] [data-mp-play]{
  width:38px !important;height:38px !important;border-radius:50% !important;
  background:#2f6fed !important;border:0 !important;color:#fff !important;}
[data-mp] [data-mp-play]:hover:not(:disabled){
  background:#3b82f6 !important;color:#fff !important;filter:none !important;}
[data-mp] [data-mp-play]:disabled{opacity:.45 !important;}
[data-mp-volwrap]{display:flex;align-items:center;gap:6px;margin-left:4px;}
[data-mp-vol]{width:86px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary,#3b82f6);cursor:pointer;}
[data-mp-orderlabel]{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-mp-status]{font-size:11px;padding:5px 10px;border-radius:7px;background:rgba(234,179,8,.14);
  color:var(--dsw-alias-state-warn-primary,#b45309);flex:none;}
[data-mp][data-drop] [data-mp-listcol]{border-color:var(--dsw-alias-brand-primary,#3b82f6);
  background:rgba(59,130,246,.08);}
[data-mp-row][data-compact]{min-height:26px;padding:3px 10px;}
/* 正在播放的三角 —— 用 CSS 画，避免字体缺字形变成豆腐块 */
[data-mp-tri]{display:inline-block;width:0;height:0;border-style:solid;
  border-width:4.5px 0 4.5px 7px;border-color:transparent transparent transparent currentColor;}
[data-mp-selmark]{opacity:.7;font-weight:700;}
[data-mp-settingswrap]{flex:1;min-height:0;overflow:auto;}
[data-mp-set]{display:flex;flex-direction:column;gap:12px;padding:2px 2px 14px;max-width:780px;}
[data-mp-set-group]{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:10px;
  padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:rgba(127,127,127,.04);}
[data-mp-set-title]{font-size:12px;font-weight:700;letter-spacing:.03em;color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-mp-set-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;}
[data-mp-set-label]{min-width:104px;}
[data-mp-set-note]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-mp-set-select]{height:28px;padding:0 8px;font-size:12px;border-radius:7px;font-family:inherit;color:inherit;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:var(--dsw-alias-bg-base,transparent);}
[data-mp-set-check]{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;}
[data-mp-eqgrid]{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:8px 6px;}
[data-mp-eqband]{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:9.5px;
  color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-mp-eqband] input{width:100%;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary,#3b82f6);}
[data-mp-set-actions]{display:flex;gap:8px;flex-wrap:wrap;}
[data-mp-badge]{font-size:10px;padding:1px 7px;border-radius:999px;background:rgba(59,130,246,.16);
  color:var(--dsw-alias-brand-primary,#60a5fa);}
@media (max-width:720px){[data-mp-side]{display:none;}}
`

    /* ───────────────────────── 入口图标（左侧图标条） ───────────────────────── */
    function EntryIcon() {
      return h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M9 18V5.5l10-2.4V16', stroke: 'currentColor', strokeWidth: 1.7,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('circle', { cx: 6.6, cy: 18.2, r: 2.6, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('circle', { cx: 16.6, cy: 16.1, r: 2.6, stroke: 'currentColor', strokeWidth: 1.7 }),
      )
    }

    /* ───────────────────────── 设置页（对齐 foobar 的选项密度） ───────────────────────── */
    function SettingsPage(props) {
      const p = props || {}
      const [s, setS] = useState(() => ENGINE.snap())
      useEffect(() => ENGINE.subscribe(setS), [])
      const st = s.settings || DEFAULT_SETTINGS
      const bands = Array.isArray(st.eqBands) && st.eqBands.length === 18 ? st.eqBands : DEFAULT_SETTINGS.eqBands
      const presetNames = Object.keys(EQ_PRESETS)
      const matched = presetNames.find((n) => EQ_PRESETS[n].join(',') === bands.join(','))
      const presetValue = matched || '自定义'
      const set = (patch) => ENGINE.setSettings(patch)
      const toggle = (key) => set({ [key]: !st[key] })
      const setBand = (i, v) => {
        const arr = bands.slice()
        arr[i] = Number(v) || 0
        set({ eqBands: arr, eqPreset: '自定义' })
      }
      const applyPreset = (name) => {
        const vals = EQ_PRESETS[name]
        if (vals) set({ eqBands: vals.slice(), eqPreset: name })
      }
      const check = (key, label, def = true) => h('label', { 'data-mp-set-row': '', 'data-mp-set-check': '' },
        h('input', { type: 'checkbox', checked: def ? st[key] !== false : !!st[key], onChange: () => toggle(key) }),
        label,
      )
      const opt = (value, label) => h('option', { key: value, value }, label)

      return h('div', { 'data-mp-set': '' },
        h('div', { 'data-mp-set-actions': '' },
          p.onClose ? h('button', { 'data-mp-btn': '', onClick: p.onClose }, h(Icon.back), '返回播放') : null,
          h('button', { 'data-mp-btn': '', onClick: () => ENGINE.resetSettings() }, '重置全部设置'),
        ),

        h('div', { 'data-mp-set-group': '' },
          h('div', { 'data-mp-set-title': '' }, '播放'),
          h('div', { 'data-mp-set-row': '' },
            h('span', { 'data-mp-set-label': '' }, '默认播放顺序'),
            h('select', {
              'data-mp-set-select': '', value: s.order,
              onChange: (e) => ENGINE.setOrder(e.target.value),
            }, Object.keys(ORDER_META).map((k) => opt(k, ORDER_META[k].label))),
          ),
          check('stopResets', '停止时回到曲首'),
          check('autoNext', '一首放完自动下一首（关掉就停在曲尾）'),
        ),

        h('div', { 'data-mp-set-group': '' },
          h('div', { 'data-mp-set-title': '' }, '均衡器（18 段 · 对齐 foobar 的 foo_dsp_eq）'),
          h('div', { 'data-mp-set-row': '' },
            h('label', { 'data-mp-set-check': '' },
              h('input', { type: 'checkbox', checked: !!st.eqEnabled, onChange: () => toggle('eqEnabled') }),
              '启用均衡器',
            ),
            h('span', { 'data-mp-badge': '' }, s.eqReady ? '音频图已建立' : '启用后建立音频图'),
          ),
          h('div', { 'data-mp-set-row': '' },
            h('span', { 'data-mp-set-label': '' }, '预设'),
            h('select', {
              'data-mp-set-select': '', value: presetValue,
              onChange: (e) => applyPreset(e.target.value),
            }, presetNames.map((n) => opt(n, n)), opt('自定义', '自定义')),
            h('span', { 'data-mp-set-note': '' }, '取自本机 foobar2000 的 .feq'),
          ),
          h('div', { 'data-mp-set-row': '' },
            h('span', { 'data-mp-set-label': '' }, '预增益'),
            h('input', {
              type: 'range', min: -12, max: 12, step: 0.5, value: st.eqPreamp, style: { width: 180 },
              onChange: (e) => set({ eqPreamp: Number(e.target.value) }),
            }),
            h('span', { 'data-mp-set-note': '' }, `${Number(st.eqPreamp || 0).toFixed(1)} dB`),
          ),
          h('div', { 'data-mp-eqgrid': '' }, bands.map((v, i) => h('div', { key: i, 'data-mp-eqband': '' },
            h('input', {
              type: 'range', min: -20, max: 20, step: 1, value: v,
              'aria-label': EQ_FREQS[i] + ' Hz',
              onChange: (e) => setBand(i, e.target.value),
            }),
            h('span', { 'data-val': '' }, (v > 0 ? '+' : '') + v),
            h('span', null, EQ_FREQS[i] >= 1000 ? (EQ_FREQS[i] / 1000) + 'k' : String(EQ_FREQS[i])),
          ))),
          h('div', { 'data-mp-set-actions': '' },
            h('button', { 'data-mp-btn': '', onClick: () => set({ eqBands: EQ_PRESETS.Flat.slice(), eqPreset: 'Flat' }) }, '拉平'),
            h('button', {
              'data-mp-btn': '',
              onClick: () => ENGINE.setSettings({ eqEnabled: false, eqBands: EQ_PRESETS.Flat.slice(), eqPreset: 'Flat', eqPreamp: 0 }),
            }, '关闭并重置'),
          ),
          h('div', { 'data-mp-set-note': '' }, 'peaking biquad 逐段叠加；关掉只是把所有段归 0（音频图建立后无法撤回直连）。'),
        ),

        h('div', { 'data-mp-set-group': '' },
          h('div', { 'data-mp-set-title': '' }, '播放列表'),
          check('rememberList', '记住播放列表（刷新 / 插件升级后还在）'),
          check('showIndex', '显示序号 / 播放标记'),
          check('showArtist', '显示歌手 · 专辑'),
          check('showDuration', '显示时长'),
          check('compact', '紧凑模式（行更矮）', false),
          h('div', { 'data-mp-set-row': '' },
            h('span', { 'data-mp-set-label': '' }, '搜索范围'),
            h('select', {
              'data-mp-set-select': '', value: st.searchScope || 'all',
              onChange: (e) => set({ searchScope: e.target.value }),
            },
              opt('all', '全部字段'), opt('title', '只搜歌名'), opt('artist', '只搜歌手'), opt('album', '只搜专辑')),
          ),
          h('div', { 'data-mp-set-actions': '' },
            h('button', {
              'data-mp-btn': '',
              onClick: () => { ENGINE.forgetAll(); ENGINE.setStatus('已清除本机保存的播放列表（当前列表还在）') },
            }, '清除已保存的列表'),
          ),
          h('div', { 'data-mp-set-note': '' },
            '歌的文件本体存在浏览器 IndexedDB 里（只在本机，不上传），所以关掉页面、升级插件都不会丢。',
            '单个文件超过 512MB 不保存。'),
        ),

        h('div', { 'data-mp-set-group': '' },
          h('div', { 'data-mp-set-title': '' }, '标签与封面'),
          check('readTags', '读取 ID3 / FLAC 标签（歌名、歌手、专辑）'),
          check('readCover', '读取内嵌封面'),
          h('div', { 'data-mp-set-note': '' }, '关掉可以更快地批量添加；已经加进来的不会变。'),
        ),

        h('div', { 'data-mp-set-group': '' },
          h('div', { 'data-mp-set-title': '' }, '播放增益（ReplayGain）'),
          h('div', { 'data-mp-set-row': '' },
            h('span', { 'data-mp-set-label': '' }, '源模式'),
            h('select', {
              'data-mp-set-select': '', value: st.gainMode || 'processing',
              onChange: (e) => set({ gainMode: e.target.value }),
            },
              opt('none', '无增益'), opt('track', '按音轨'), opt('album', '按专辑'),
              opt('processing', '处理（教程设置）')),
          ),
          h('label', { 'data-mp-set-check': '' },
            h('input', {
              type: 'checkbox', checked: !!st.replayGain,
              onChange: () => toggle('replayGain'),
            }),
            '启用 ReplayGain 处理（教程里 DSP 留空，默认关闭）',
          ),
          h('div', { 'data-mp-set-note': '' },
            '浏览器拿不到 foobar 的增益标签扫描结果，这里只做开关记录；',
            '想真按标签调音量，可以后面接 Web Audio 的 GainNode（目前未启用）。'),
        ),

        h('div', { 'data-mp-set-group': '' },
          h('div', { 'data-mp-set-title': '' }, '输出与缓冲'),
          h('div', { 'data-mp-set-row': '' },
            h('span', { 'data-mp-set-label': '' }, '缓冲长度'),
            h('select', {
              'data-mp-set-select': '', value: String(st.bufferMs || 1000),
              onChange: (e) => set({ bufferMs: Number(e.target.value) }),
            }, BUFFER_CHOICES.map((v) => opt(String(v), v + ' 毫秒'))),
            h('span', { 'data-mp-set-note': '' }, '教程设 1000 毫秒；太低容易爆音/卡顿'),
          ),
          h('div', { 'data-mp-set-row': '' },
            h('span', { 'data-mp-set-label': '' }, '输出设备'),
            h('select', {
              'data-mp-set-select': '', value: st.outputDevice || 'auto',
              onChange: (e) => set({ outputDevice: e.target.value }),
            },
              opt('auto', '系统默认'),
              opt('exclusive', '默认：小尾巴（独占）'),
              opt('asio', 'ASIO 小尾巴'),
            ),
          ),
          check('exclusive', '独占输出（教程：勾选独占，避免被别的程序混音）'),
          h('div', { 'data-mp-set-note': '' },
            '⚠️ 浏览器不能选 ASIO/WASAPI 设备、也没有真正的「独占」：',
            '这里只影响 Web Audio 的 latencyHint（缓冲策略），设备仍由系统/浏览器决定。'),
        ),

        h('div', { 'data-mp-set-group': '' },
          h('div', { 'data-mp-set-title': '' }, 'DSD（DSF / DFF）'),
          check('dsdDecode', '把 DSD 软解成 44.1k PCM 再播放（教程⑥ 输出类型 PCM→DSD）'),
          h('div', { 'data-mp-set-row': '' },
            h('span', { 'data-mp-set-label': '' }, '转换模式'),
            h('select', {
              'data-mp-set-select': '', value: st.dsdMode || 'passthrough',
              onChange: (e) => set({ dsdMode: e.target.value }),
            },
              opt('passthrough', '直通（教程设置）'),
              opt('dsd2pcm', 'DSD2PCM'),
            ),
          ),
          h('div', { 'data-mp-set-note': '' },
            '教程里这两项是「输出类型：PCM → DSD」「转换模式：直通」，目的是让 DSD 原样交给解码器。',
            '浏览器没有 ASIO/DoP，做不到 foobar + foo_input_sacd 的硬解，只能软解：',
            '1-bit 抽取 + 低通 → WAV 再播；DSD64/128/256 支持，DST 压缩的 DFF 不支持。'),
        ),

        h('div', { 'data-mp-set-group': '' },
          h('div', { 'data-mp-set-title': '' }, '关于'),
          h('div', { 'data-mp-set-note': '' },
            '能放：MP3 / FLAC / WAV / OGG / M4A / AAC / Opus / WebM / DSF / DFF（软解）。',
            '浏览器解不了的（APE / WMA / ALAC 等）只能显示、放不出声。',
            '播放列表在内存里，刷新页面清空。'),
        ),
      )
    }

    /* ───────────────────────── 播放面板 ───────────────────────── */
    function Player() {
      const [s, setS] = useState(() => ENGINE.snap())
      const [drag, setDrag] = useState(false)
      const fileRef = useRef(null)
      const dragDepth = useRef(0)

      useEffect(() => ENGINE.subscribe(setS), [])

      const cur = s.index >= 0 ? s.tracks[s.index] : null
      const st = s.settings || DEFAULT_SETTINGS
      const q = s.filter.trim().toLowerCase()
      const scope = st.searchScope || 'all'
      const rows = []
      s.tracks.forEach((t, i) => {
        if (q) {
          let hay
          if (scope === 'title') hay = `${t.title || t.name} ${t.name}`
          else if (scope === 'artist') hay = t.artist || ''
          else if (scope === 'album') hay = t.album || ''
          else hay = `${t.title || t.name} ${t.artist || ''} ${t.album || ''} ${t.name}`
          if (!hay.toLowerCase().includes(q)) return
        }
        rows.push({ t, i })
      })
      const totalDur = s.tracks.reduce((a, t) => a + (t.duration || t.realDuration || 0), 0)

      const pick = () => { try { fileRef.current && fileRef.current.click() } catch { /* 忽略 */ } }
      const onFiles = (list) => { ENGINE.addFiles(list) }
      const onDrop = (e) => {
        e.preventDefault()
        dragDepth.current = 0
        setDrag(false)
        try {
          if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) onFiles(e.dataTransfer.files)
        } catch { /* 忽略 */ }
      }
      const onDragEnter = (e) => { e.preventDefault(); dragDepth.current++; setDrag(true) }
      const onDragLeave = (e) => { e.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDrag(false) }
      const onDragOver = (e) => { e.preventDefault() }

      const orderInfo = ORDER_META[s.order] || ORDER_META.order
      const rawMax = s.duration || (cur && (cur.duration || cur.realDuration)) || 0
      const seekMax = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 0
      const seekVal = Math.max(0, Math.min(s.time, seekMax || 0))
      const volPct = Math.round((s.muted ? 0 : s.volume) * 100)

      return h('div', {
        'data-mp': '',
        'data-drop': drag ? '' : undefined,
        onDragEnter,
        onDragLeave,
        onDragOver,
        onDrop,
      },
        /* ── 顶栏 ── */
        h('div', { 'data-mp-head': '' },
          h('div', { 'data-mp-logo': '' }, h(Icon.music)),
          h('div', null,
            h('div', { 'data-mp-title': '' }, '音乐播放器'),
            h('div', { 'data-mp-sub': '' },
              s.tracks.length
                ? `${s.tracks.length} 首 · 共 ${fmtTime(totalDur)}${q ? ` · 筛出 ${rows.length}` : ''}`
                : '本地文件 · 不上传 · 零联网'),
          ),
          h('div', { 'data-mp-grow': '' }),
          h('label', { 'data-mp-searchwrap': '', style: s.settingsOpen ? { display: 'none' } : undefined },
            h(Icon.search),
            h('input', {
              'data-mp-search': '', type: 'text', placeholder: '搜索歌名 / 歌手 / 专辑',
              value: s.filter,
              onChange: (e) => ENGINE.setFilter(e.target.value),
            }),
          ),
          h('button', { 'data-mp-btn': '', 'data-primary': '', title: '从本机添加音频文件', onClick: pick },
            h(Icon.plus), '添加音乐'),
          h('button', {
            'data-mp-btn': '', title: '清空播放列表', disabled: !s.tracks.length,
            onClick: () => ENGINE.clear(),
          }, h(Icon.trash), '清空'),
          h('button', {
            'data-mp-btn': '', title: '播放设置（均衡器等）',
            onClick: () => ENGINE.setSettingsOpen(!s.settingsOpen),
          }, h(Icon.gear), '设置'),
          h('input', {
            ref: fileRef, type: 'file', accept: ACCEPT,
            multiple: true, style: { display: 'none' },
            onChange: (e) => {
              try { if (e.target.files && e.target.files.length) onFiles(e.target.files) } catch { /* 忽略 */ }
              try { e.target.value = '' } catch { /* 忽略 */ }
            },
          }),
        ),

        s.status ? h('div', { 'data-mp-status': '' }, s.status) : null,

        /* ── 主体：设置页 / 播放列表 + 封面 ── */
        s.settingsOpen
          ? h('div', { 'data-mp-settingswrap': '' }, h(SettingsPage, { onClose: () => ENGINE.setSettingsOpen(false) }))
          : h('div', { 'data-mp-body': '' },
          h('div', { 'data-mp-listcol': '' },
            s.tracks.length === 0
              ? h('div', { 'data-mp-empty': '' },
                  h('div', { style: { opacity: .9 } }, h(Icon.music)),
                  h('div', null, '点「添加音乐」从本机选音频，或把文件直接拖到这里'),
                  h('div', { style: { fontSize: 10.5, opacity: .8 } }, '支持 MP3 / FLAC / WAV / OGG / M4A / AAC / Opus / DSF / DFF（软解）等'),
                )
              : rows.length === 0
                ? h('div', { 'data-mp-empty': '' }, '没有匹配「' + s.filter + '」的曲目')
                : h('div', { 'data-mp-list': '' }, rows.map(({ t, i }) =>                    h('div', {
                      key: t.id,
                      'data-mp-row': '',
                      'data-compact': st.compact ? '' : undefined,
                      'data-on': i === s.index ? '' : undefined,
                      'data-sel': i === s.selected ? '' : undefined,
                      // 单击只选中；双击才播放（误点不会突然出声）
                      onClick: () => ENGINE.selectAt(i),
                      onDoubleClick: () => ENGINE.playAt(i),
                      title: (t.title || t.name) + (t.artist ? ' — ' + t.artist : '') + '（双击播放）',
                    },
                      st.showIndex
                        ? h('span', { 'data-mp-idx': '' },
                            i === s.index
                              ? h('span', { 'data-mp-tri': '' })       // 正在播放：三角
                              : (i === s.selected ? h('span', { 'data-mp-selmark': '' }, '·') : (i + 1)))
                        : null,
                      h('div', { 'data-mp-info': '' },
                        h('span', { 'data-mp-name': '' }, t.title || t.name),
                        (st.showArtist && (t.artist || t.album))
                          ? h('span', { 'data-mp-artist': '' }, [t.artist, t.album].filter(Boolean).join(' · '))
                          : null,
                      ),
                      st.showDuration
                        ? h('span', { 'data-mp-dur': '' },
                            t.dsd && t.decoding ? '转码'
                              : (t.duration || t.realDuration) ? fmtTime(t.duration || t.realDuration)
                                : t.dsd ? 'DSD' : (t.loading ? '…' : '--:--'))
                        : null,
                      h('button', {
                        'data-mp-rm': '', title: '从列表移除',
                        onClick: (e) => { e.stopPropagation(); ENGINE.removeAt(i) },
                      }, h(Icon.trash)),
                    ),
                  )),
          ),
          h('div', { 'data-mp-side': '' },
            h('div', { 'data-mp-cover': '' },
              cur && cur.coverUrl
                ? h('img', { src: cur.coverUrl, alt: '', draggable: false })
                : h(Icon.music),
            ),
            h('div', { 'data-mp-nowinfo': '' },
              h('div', { 'data-mp-nowtitle': '' }, cur ? (cur.title || cur.name) : '未在播放'),
              h('div', { 'data-mp-nowartist': '' },
                cur ? ([cur.artist, cur.album].filter(Boolean).join(' · ') || '未知艺术家') : '从播放列表里选一首'),
            ),
          ),
        ),

        /* ── 底部传输条 ── */
        h('div', { 'data-mp-bar': '' },
          h('div', { 'data-mp-seekrow': '' },
            h('span', null, fmtTime(seekVal)),
            h('input', {
              'data-mp-seek': '', type: 'range', min: 0,
              max: Math.max(1, Math.floor(seekMax)), step: 1,
              value: Math.floor(seekVal),
              disabled: !cur,
              'aria-label': '进度',
              onChange: (e) => ENGINE.seek(Number(e.target.value)),
            }),
            h('span', null, fmtTime(seekMax)),
          ),
          h('div', { 'data-mp-ctrl': '' },
            h('button', {
              'data-mp-ibtn': '', title: orderInfo.label + '（点击切换）',
              onClick: () => ENGINE.cycleOrder(),
            }, h(orderInfo.icon)),
            h('span', { 'data-mp-orderlabel': '' }, orderInfo.label),
            h('div', { 'data-mp-grow': '' }),
            h('button', { 'data-mp-ibtn': '', title: '上一首', disabled: !s.tracks.length, onClick: () => ENGINE.prev() }, h(Icon.prev)),
            h('button', {
              'data-mp-ibtn': '', 'data-mp-play': '', title: s.playing ? '暂停' : '播放',
              disabled: !s.tracks.length, onClick: () => ENGINE.toggle(),
            }, h(s.playing ? Icon.pause : Icon.play)),
            h('button', { 'data-mp-ibtn': '', title: '停止', disabled: !cur, onClick: () => ENGINE.stop() }, h(Icon.stop)),
            h('button', { 'data-mp-ibtn': '', title: '下一首', disabled: !s.tracks.length, onClick: () => ENGINE.next(false) }, h(Icon.next)),
            h('div', { 'data-mp-grow': '' }),
            h('div', { 'data-mp-volwrap': '' },
              h('button', {
                'data-mp-ibtn': '', 'data-active': s.muted ? '' : undefined,
                title: s.muted ? '取消静音' : '静音', onClick: () => ENGINE.toggleMute(),
              }, h(Icon.volume, { muted: s.muted })),
              h('input', {
                'data-mp-vol': '', type: 'range', min: 0, max: 100, step: 1,
                value: volPct, 'aria-label': '音量',
                onChange: (e) => ENGINE.setVolume(Number(e.target.value) / 100),
              }),
            ),
          ),
        ),
      )
    }

    /* ───────────────────────── 挂载 ───────────────────────── */
    return {
      inject: ['slots'],
      apply(ctx) {
        // 样式：随插件卸载一起清掉
        let style = null
        try {
          style = document.createElement('style')
          style.setAttribute('data-plugin-css', ENTRY_ID)
          style.textContent = CSS
          document.head.appendChild(style)
        } catch (err) { cheap('注入样式失败：' + String(err?.message ?? err)) }
        if (style) ctx.effect(() => () => { try { style.remove() } catch { /* 忽略 */ } }, ENTRY_ID + ': 样式')

        // 插件卸载时停掉声音，别留个幽灵播放
        ctx.effect(() => () => {
          try { if (ENGINE.audio) { ENGINE.audio.pause(); ENGINE.audio.removeAttribute('src') } } catch { /* 忽略 */ }
        }, ENTRY_ID + ': 停止播放')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        // ⚠️ 顺序很重要：宿主要求「选中一条 panellist 入口时，main 里必须有同 id 的面板，
        //    找不到会抛（且不改当前选择）」——所以先登记 main 面板，成功了才登记左侧图标。
        let mainOk = false
        try {
          slots.inject('main', () => slots.register(
            { name: 'main', key: ENTRY_ID },
            () => h(Player),
          ))
          mainOk = true
        } catch (err) { cheap('登记 main 面板失败：' + String(err?.message ?? err)) }

        if (mainOk) {
          try {
            slots.inject('sidebar.panellist', () => slots.register(
              { name: 'sidebar.panellist', id: ENTRY_ID, order: 60, label: '音乐播放器' },
              () => h(EntryIcon),
            ))
          } catch (err) {
            cheap('登记左侧入口失败：' + String(err?.message ?? err))
            mainOk = false
          }
        }

        // 设置页：不管左侧入口成没成，都在「设置」里放一页（跟 foobar 的 Preferences 一样）
        try {
          slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: ENTRY_ID + '-settings', order: 42, label: '音乐播放器' },
            () => h(SettingsPage),
          ))
        } catch (err) { cheap('挂设置页失败：' + String(err?.message ?? err)) }

        // 兜底：左侧放不了（宿主没有这些槽位）时，把播放器本体也挂到「设置」页，照样能放歌。
        if (!mainOk) {
          try {
            slots.inject('settings.section', () => slots.register(
              { name: 'settings.section', id: ENTRY_ID, order: 43, label: '音乐播放器（播放）' },
              () => h(Player),
            ))
          } catch (err) { cheap('兜底挂设置页也失败：' + String(err?.message ?? err)) }
        }
      },
    }
  },
})
