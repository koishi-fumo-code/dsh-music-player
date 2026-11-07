#!/usr/bin/env node
/**
 * scripts/make-tgz.mjs —— 打成可分发的 .tgz（换台电脑直接装）
 * ============================================================================
 * 为什么需要：`link:D:\dsh工作区\...` 只在这台机器成立。要给别人用，得有个
 * 自带全部文件的包，装到对方机器时链接指向**那台机器上的真实路径**。
 *
 * 产出：dist/dsh-music-player-<version>.tgz
 *   · 内容按 package.json 的 files 收敛
 *   · 附带 INSTALL.txt
 *
 * 用法：
 *   node scripts/make-tgz.mjs           # 产出 tgz
 *   node scripts/make-tgz.mjs --verify  # 产出后解开装进隔离 DSH_HOME 自检
 * ============================================================================
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync,
} from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const INNER = `${pkg.name}-${pkg.version}`
const STAGE_PARENT = join(ROOT, '.stage')
const STAGE = join(STAGE_PARENT, INNER)
const DIST = join(ROOT, 'dist')
const OUT = join(DIST, `${INNER}.tgz`)

let pass = 0, fail = 0
const ok = (c, label, detail = '') => {
  if (c) { pass++; console.log(`  [OK]   ${label}`) }
  else { fail++; console.log(`  [FAIL] ${label}${detail ? ' —— ' + detail : ''}`) }
}

const ALWAYS = ['package.json', 'install.cmd', 'install.ps1', 'INSTALL.txt']

function copyItem(name) {
  const src = join(ROOT, name)
  const dst = join(STAGE, name)
  if (!existsSync(src)) return false
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(src, dst, { recursive: true })
  return true
}

/** files 白名单里的 `locale/*.json` 这类通配 → 展开成实际文件 */
function expandPattern(pat) {
  if (!pat.includes('*')) return [pat]
  const slash = pat.lastIndexOf('/')
  const dir = slash >= 0 ? pat.slice(0, slash) : '.'
  const namePat = slash >= 0 ? pat.slice(slash + 1) : pat
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return []
  const re = new RegExp('^' + namePat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  return readdirSync(abs).filter((n) => re.test(n)).map((n) => (dir === '.' ? n : `${dir}/${n}`))
}

console.log('\n① 收拢要分发的文件')
{
  rmSync(STAGE_PARENT, { recursive: true, force: true })
  mkdirSync(STAGE, { recursive: true })
  const wanted = new Set([...(pkg.files || []), ...ALWAYS])
  let copied = 0
  for (const pat of wanted) {
    if (pat === 'INSTALL.txt') continue
    const actual = expandPattern(pat)
    if (!actual.length) { console.log(`     （跳过不存在的 ${pat}）`); continue }
    for (const name of actual) { if (copyItem(name)) copied++ }
  }
  ok(copied >= (pkg.files || []).length, `按 files 白名单拷了 ${copied} 项`)
  for (const f of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/zh.json', 'locale/en.json', 'scripts/install.mjs']) {
    ok(existsSync(join(STAGE, f)), `含 ${f}`)
  }
  ok(!existsSync(join(STAGE, 'node_modules')), '不带 node_modules')
  ok(!existsSync(join(STAGE, '.stage')), '不会把 .stage 拷进去')
  const junk = []
  const scan = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) scan(p)
      else if (/\.bak-|\.tgz$|\.log$/.test(n)) junk.push(relative(STAGE, p))
    }
  }
  scan(STAGE)
  ok(junk.length === 0, '没有备份 / 旧包 / 日志混进来', junk.join(', '))
}

console.log('\n② 写 INSTALL.txt')
{
  writeFileSync(join(STAGE, 'INSTALL.txt'), `${pkg.name} ${pkg.version} — 换台电脑怎么装
====================================================================

【最快】Windows 双击 install.cmd
       自动找 Node 和 DSH 的 profile 目录，装完提示重启 DSH。

【手动】有 Node 22+ 就能敲命令（Windows / macOS / Linux 都一样）：
       node scripts/install.mjs
       node scripts/install.mjs --dry          只看看会改什么
       node scripts/install.mjs --verify-only  只自检不写东西
       node scripts/install.mjs --uninstall    摘掉

【装完】
  1. 完全关掉再打开 DeepSeek Harness（bundles 是启动时组合的）
  2. 左侧图标条会多一个音符图标，点开就是播放器
  3. 设置 → 「音乐播放器」可调均衡器 / DSD / 缓冲

【要求】
  · DSH 至少启动过一次（要存在 <DSH_HOME>/profiles/<名字>/）
  · Node 22+；或者装着 DSH（用自带运行时）
  · 本机音乐文件（MP3/FLAC/WAV/OGG/M4A/AAC/Opus/DSF/DFF）

【这个包不碰你什么】
  · 不写你的 cordis.patch.yml（入口在包自带 patch 里，卸载能清干净）
  · 不用管理员权限，不装全局包，零运行时依赖
  · 播放列表只在内存，音乐文件不上传、不联网
`, 'utf8')
  ok(existsSync(join(STAGE, 'INSTALL.txt')), 'INSTALL.txt 写好了')
}

console.log('\n③ 打包')
{
  mkdirSync(DIST, { recursive: true })
  rmSync(OUT, { force: true })
  // ⚠️ Windows 自带 tar 会把 D: 当成远程主机名，所以 cwd 设在 .stage 上一层、只给相对路径
  const outRel = relative(STAGE_PARENT, OUT).replace(/\\/g, '/')
  try {
    execFileSync('tar.exe', ['-czf', outRel, INNER], { cwd: STAGE_PARENT, stdio: 'pipe' })
  } catch (e) {
    // 非 Windows 或没有 tar.exe：用 pnpm/npm pack 兜底
    try {
      execFileSync(process.platform === 'win32' ? 'tar' : 'tar', ['-czf', OUT, '-C', STAGE_PARENT, INNER], { stdio: 'pipe' })
    } catch (e2) {
      console.log(`     tar 失败：${e.message.split('\n')[0]} / ${e2.message.split('\n')[0]}`)
    }
  }
  ok(existsSync(OUT), `产出 ${relative(ROOT, OUT)}`)
  if (existsSync(OUT)) {
    const size = statSync(OUT).size
    ok(size > 10 * 1024, `包大小合理（${(size / 1024).toFixed(0)} KB）`)
    console.log(`     ${OUT}`)
  }
}

console.log('\n④ 包内清单核对')
{
  try {
    const outRel = relative(STAGE_PARENT, OUT).replace(/\\/g, '/')
    const list = execFileSync('tar.exe', ['-tzf', outRel], { encoding: 'utf8', cwd: STAGE_PARENT })
    const entries = list.split('\n').filter(Boolean)
    for (const f of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'install.cmd', 'scripts/install.mjs']) {
      ok(entries.some((e) => e.endsWith(f.replace(/\//g, '/')) || e.includes(f)), `包里有 ${f}`)
    }
    ok(entries.every((e) => !e.includes('node_modules')), '包里没有 node_modules')
    ok(entries.every((e) => !e.includes('.stage')), '包里没有 .stage')
    console.log(`     ${entries.length} 个条目`)
  } catch (e) { ok(false, '能列出包内容', e.message.split('\n')[0]) }
}

if (process.argv.includes('--verify')) {
  console.log('\n⑤ 解出来装进隔离 DSH_HOME 自检')
  try {
    // 刻意放在系统临时目录（而不是插件目录下），这样才真的模拟「另一台电脑」
    const sandbox = join(tmpdir(), 'dsh-music-verify-' + Date.now())
    mkdirSync(sandbox, { recursive: true })
    execFileSync('tar.exe', ['-xzf', OUT, '-C', sandbox], { stdio: 'pipe' })
    const extracted = join(sandbox, INNER)
    ok(existsSync(join(extracted, 'index.js')), '解压后 index.js 在')

    // 造一个假 profile
    const home = join(sandbox, 'home')
    const prof = join(home, 'profiles', 'desktop')
    mkdirSync(prof, { recursive: true })
    writeFileSync(join(prof, 'package.json'), JSON.stringify({
      name: 'desktop-profile',
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, null, 2) + '\n', 'utf8')

    execFileSync(process.execPath, [join(extracted, 'scripts', 'install.mjs')], {
      env: { ...process.env, DSH_HOME: home },
      stdio: 'pipe',
    })

    const after = JSON.parse(readFileSync(join(prof, 'package.json'), 'utf8'))
    ok(after.dsh.profile.bundles.includes(pkg.name), '装进了假 profile 的 bundles')
    ok(!!after.dependencies[pkg.name], '登记了 dependencies')
    ok(existsSync(join(prof, 'node_modules', pkg.name)), 'node_modules 链接存在')
    const depSpec = String(after.dependencies[pkg.name] || '')
    const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase()
    ok(norm(depSpec).startsWith('link:'), '依赖是 link: 形式', depSpec)
    ok(norm(depSpec).includes(norm(home)) || norm(depSpec).includes(norm(sandbox)),
      '依赖指向的是假电脑上的路径（没绑死打包机的路径）', depSpec)
    ok(!norm(depSpec).includes('dsh工作区'), '依赖没有指向打包机的 D:\\dsh工作区', depSpec)

    // 卸载
    execFileSync(process.execPath, [join(extracted, 'scripts', 'install.mjs'), '--uninstall'], {
      env: { ...process.env, DSH_HOME: home },
      stdio: 'pipe',
    })
    const done = JSON.parse(readFileSync(join(prof, 'package.json'), 'utf8'))
    ok(!done.dsh.profile.bundles.includes(pkg.name), '卸载后 bundles 干净')
    ok(!done.dependencies[pkg.name], '卸载后 dependencies 干净')

    rmSync(sandbox, { recursive: true, force: true })
  } catch (e) {
    ok(false, '隔离环境自检', String(e?.message ?? e).split('\n')[0])
  }
}

rmSync(STAGE_PARENT, { recursive: true, force: true })

console.log(`\n${fail === 0 ? '通过' : '失败'}：${pass} 条通过，${fail} 条失败`)
if (fail) process.exit(1)
console.log(`\n⇒ 把 dist/${INNER}.tgz 发给别人：解压后双击 install.cmd（Windows）`)
console.log('   或直接整个文件夹拷过去，跑 node scripts/install.mjs')
