# dsh-music-player —— 本地音乐播放器（DSH 插件）

左侧图标条一个「音乐」入口，点开在主工作区播放本机音乐。
参考 foobar2000 / foobox 的播放列表 + 封面 + 传输条 + 18 段均衡器，但全部跑在浏览器里：
**零联网、零依赖、文件不上传**。

▶ 介绍视频（2 分 19 秒）：[dsh-music-player-intro.mp4](https://github.com/koishi-fumo-code/dsh-music-player/releases/download/v0.4.0/dsh-music-player-intro.mp4)

## 装

### 方式一：本机开发用（插件管理器）

包自带 `cordis.patch.yml`，用插件管理器安装即可：

```
plugin_manager  action=install_bundle  target=<插件目录的绝对路径>
```

### 方式二：换台电脑 / 发给别人（推荐）

不用插件管理器，用自带安装器，零依赖、跨平台：

```bash
# Windows 直接双击
install.cmd

# 或者任意系统用 Node 22+
node scripts/install.mjs              # 装到所有 profile
node scripts/install.mjs --dry        # 只看会改什么
node scripts/install.mjs --verify-only
node scripts/install.mjs --uninstall  # 卸载
```

它会自动找 `DSH_HOME`、扫 `profiles/*`、建链接、登记 bundles，**不写你的
`cordis.patch.yml`**。装完**完全重启一次 DSH**。

要打成可分发的 `.tgz`：

```bash
node scripts/portability-check.mjs    # 自检有没有绑死本机
node scripts/simulate-foreign-pc.mjs  # 造一台假电脑全流程验证
node scripts/make-tgz.mjs --verify    # 产出 dist/*.tgz 并再验一次
```

分发细节见 [分发说明.md](分发说明.md)。

安装后侧栏图标会出现；改了源码后刷新页面一次即可加载新代码（本地目录是 link 安装）。

卸载：插件管理器里卸载 `dsh-music-player`，或 `node scripts/install.mjs --uninstall`。

## 功能

- **入口**：左侧图标条（`sidebar.panellist`）；面板渲染在主工作区（`main` 槽位）。
  底部传输条上的「设置」齿轮打开**设置页**；「设置」里也有一页「音乐播放器」。
- **加歌**：点「添加音乐」多选 / 整文件夹，或把文件拖进面板。
- **播放列表**：标题 / 歌手 / 时长；**单击选中、双击播放**（误点不会突然出声）；
  悬停行尾 `🗑` 移除；搜索框按范围过滤。
- **列表会记住**：歌的文件本体存在浏览器 IndexedDB 里，关掉页面、升级插件后**不会丢**。
  设置里可关（`rememberList`）或一键清除已保存的列表。单文件 >512MB 不保存。
- **封面与标签**：解析 ID3v2（MP3）与 FLAC（Vorbis comment + PICTURE），
  读歌名 / 歌手 / 专辑 / 内嵌封面；没有内嵌封面时退回文件名。
- **传输**：上一首 / 播放暂停 / 停止 / 下一首、进度拖动、时间显示；音量 + 静音。
- **播放顺序**（对齐 foobar 的 Playback order）：
  顺序播放 → 列表循环 → 单曲循环 → 随机播放。
- **18 段均衡器**（对齐 foobar 的 `foo_dsp_eq`）：
  频段 55 Hz ~ 16 kHz，±20 dB；**20 个预设取自 foobar2000 的 `Equalizer Presets` 目录**
  （.feq 文件原值照搬：Flat / 1965 / Air / Brittle / Car Stereo / Classic V / Clear / Dark /
  DEATH / Drums / Home Theater / Loudness / Metal / Pop / Premaster / Presence /
  Punch & Sparkle / Shimmer / Soft Bass / Strings），另有预增益与「自定义」。
- **DSD 软解**：DSF 与未压缩 DFF（DSD64/128/256）→ 抽取成 44.1k PCM → WAV → 播放。
- **设置项**（存 `localStorage`）：默认播放顺序、停止回曲首、自动下一首、
  列表显示项（序号/歌手/时长/紧凑）、搜索范围、读标签/读封面、DSD 软解开关、
  EQ 开关/预设/预增益/18 段、一键重置。
- **后台不断**：播放引擎在模块作用域，切到会话或别的面板，歌照放；
  切回来直接接上当前进度。插件卸载时自动停声。

## 教程对齐（《Foobar2000 与小尾巴使用的配置教程》）

跟着视频逐步做了，教程的默认值已写进插件默认设置（`localStorage['dsh-music-player.settings']`，
设置页里能改，点「重置全部设置」回到教程默认）。

| 教程步骤 | 教程里的设置 | 插件怎么对应 |
|---|---|---|
| ① 安装完整版组件 | 含 `foo_input_sacd`、`foo_dsd_processor`、ASIO、FFmpeg 封装等 | 无需安装：软解和 DSD 解析内置在插件里 |
| ② 播放 → 播放增益 | 源模式＝**处理** | `gainMode: 'processing'`（默认） |
| ③ DSP 管理器 | **已装的 DSP 留空**，不挂任何处理器 | `replayGain: false`、`eqEnabled: false`（默认都不开） |
| ④ 输出 → 设备 | 缓冲长度 **1000 毫秒**（太低会爆音/卡顿） | `bufferMs: 1000` → Web Audio `latencyHint: 'playback'` |
| ⑤ 输出 → ASIO | 选小尾巴驱动、时钟默认、**独占** | `exclusive: true`、`outputDevice: 'auto'`（仅记录，见下方限制） |
| ⑥ 工具 → DSD | 输出类型 **PCM → DSD**；转换模式 **直通** | `dsdDecode: true`、`dsdMode: 'passthrough'`（默认） |
| ⑦ 拖 DSF 进主界面 | 不报错、能出声即完成 | 拖进面板即可，自动软解成 44.1k PCM 播放 |

**浏览器做不到的部分（如实说明，不假装做到了）**

- 没有 ASIO / WASAPI 设备枚举，选不了"小尾巴（独占）"；`outputDevice`、`exclusive`
  只影响缓冲策略，真实设备与混音由系统/浏览器决定。
- 没有 DoP / 原生 DSD 输出，所以教程里的「输出类型 DSD」在这里等于**软解成 PCM**，
  不是硬件直通。
- 拿不到 foobar 的 ReplayGain 扫描标签，`replayGain` 目前只是个开关位。

## 白按钮（已修，附根因）

「添加音乐」按钮原来在深色主题下静止时是一片白，鼠标移上去反而正常。原因有两层：

1. 底色用了 `--dsw-alias-brand-primary` —— 深色主题里这个 token **本身就是白色**
   （宿主主按钮＝白底黑字），照抄就白。
2. `[data-mp-btn]:hover:not(:disabled)` 优先级 (0,3,0) 高于 `[data-mp-btn][data-primary]` (0,2,0)，
   所以 hover 时被灰色规则盖掉、静止时才是白底 —— 正好对应「不放上去是白的」。

修法：改用固定蓝 `#2f6fed`（hover `#3b82f6`）+ 提高选择器优先级 + `!important` 兜底，
播放圆钮同样处理。

## 关于 DSD（重要）

浏览器没有 ASIO / DoP 输出，**做不到** foobar2000 + `foo_input_sacd` + ASIO 那种
「硬解 DSD」。本插件做的是**软解**，和 `foo_input_sacd` 的默认 PCM 模式同一思路：

1. 按 DSD64/128/256 = 44.1k × 64/128/256 的关系，把每采样 N 个 1-bit 取平均（box 抽取）；
2. 二阶低通压掉 DSD 的高频噪声整形；
3. 打包成 WAV Blob，喂给同一个 `<audio>` 播放。

限制：DST 压缩的 DFF 不支持（会提示）；大文件转码要等几秒（>768MB 直接拒绝）；
转码在内存里做，超长 DSD 很吃内存。

## 说明 / 限制

- 浏览器能解码的格式由浏览器决定（Chromium：MP3 / FLAC / WAV / OGG / M4A / AAC /
  Opus / WebM 基本都行；APE、WMA、ALAC 通常不行）。
- 播放列表在内存里；开启「记住播放列表」后会存进 IndexedDB，
  但它是**本机浏览器存储**，换浏览器/清站点数据就会没。
- 元数据只读文件头 4 MB，超大标签或超大封面可能读不到封面（不影响播放）。
- 均衡器建立 Web Audio 图后音频就固定走这张图；「关闭 EQ」只是把所有段归 0。
- 浏览器自动播放策略：首次需要你点一下播放；加歌时只选中不自动播放。

## 设置存在哪

- 播放设置：`localStorage['dsh-music-player.settings']`
- 音量 / 静音 / 播放顺序：`localStorage['dsh-music-player.prefs']`
