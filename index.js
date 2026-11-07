/**
 * dsh-music-player —— 本地音乐播放器 · DSH 插件（host 半端）
 * ============================================================================
 * 播放器**全在浏览器里跑**（client.js）：
 *   · 入口由 client.js 通过 `sidebar.panellist` 槽位注册到左侧图标条；
 *   · 点开后在 `main` 槽位渲染播放面板（播放列表 + 封面 + 传输控制）。
 *   · 音频文件用浏览器 File API 读（`<input type="file">` / 拖拽），
 *     本机 Blob URL 播放 —— 零联网、不上传、不落盘。
 *
 * 所以 host 这边**不注册工具、不挂 HTTP 接口**：挂了反而在没有 webServer 的
 * headless profile 里给插件拖后腿。
 *
 * DSH 约定：包声明了 `main` ⇒ 必须有一个能安全 import 的入口，且
 * **apply() 绝不抛异常**（抛了会带走整个 dsh 进程）。这里守这条底线。
 * ============================================================================
 */

export const name = 'music-player'

/** 空实现：播放全在 client 半端。保留 async 签名以符合宿主调用约定。 */
export async function apply(_ctx, _config) {
  // 故意留空 —— 见文件头。任何初始化都不在这里做，避免 headless 环境报错。
}

/** 给宿主/排查看的元信息（不注册成工具） */
export function describe() {
  return {
    name,
    title: '音乐播放器',
    entry: 'sidebar.panellist', // 左侧图标条
    panel: 'main',              // 主工作区
    settings: 'settings.section',
    playback: ['order', 'repeat-all', 'repeat-one', 'shuffle'],
    equalizer: 'foobar2000 foo_dsp_eq 风格 18 段',
    dsd: 'DSF/DFF 软解为 PCM（无 ASIO 硬解）',
  }
}

// 直接 `node index.js` 时打印一下（方便人工排查，不进 DSH 也无副作用）
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  console.log(JSON.stringify(describe(), null, 2))
}
