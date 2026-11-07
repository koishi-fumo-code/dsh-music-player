#!/usr/bin/env node
/**
 * scripts/install.mjs —— 把 dsh-music-player 装进本机 DSH（幂等、可卸载、换机即用）
 * ============================================================================
 * 为什么这样写（照 dsh-seedance 踩过的坑）：
 *   · **不认死路径**：插件目录从本文件位置推，DSH_HOME 从环境变量/用户目录推；
 *     整个文件夹拷到别的电脑，直接跑这个脚本就能装。
 *   · **profile 不写死**：扫 <DSH_HOME>/profiles/*，哪个声明了
 *     dsh.profile.bundles 就装哪个。
 *   · **不写用户的 cordis.patch.yml**：入口 insert 在包自带 patch 里，
 *     卸载时跟着包走，插件管理的「卸载」能清干净。
 *   · 写 profile 的 package.json 前先备份，写完回读校验，坏 JSON 自动还原。
 *   · 跨平台：Windows 用 junction，macOS/Linux 用 symlink。
 *
 * 用法：
 *   node scripts/install.mjs                  # 自动检测，装到所有 profile
 *   node scripts/install.mjs --dry            # 只看会改什么
 *   node scripts/install.mjs --profiles desktop
 *   node scripts/install.mjs --verify-only    # 只自检，不写东西
 *   node scripts/install.mjs --uninstall      # 从所有 profile 摘掉（包本身不动）
 *   DSH_HOME=/path/to/.dsh node scripts/install.mjs
 * ============================================================================
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync,
  readdirSync, copyFileSync, unlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLUGIN_DIR = resolve(HERE, '..')
const NAME = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).name

const posix = (p) => String(p).replace(/\\/g, '/')

export function detectHome(env = process.env, home = homedir()) {
  return resolve(env.DSH_HOME || join(home, '.dsh'))
}

/** 扫描 <home>/profiles/*，返回「有 dsh.profile.bundles 的 profile」 */
export function listProfiles(home) {
  const root = join(home, 'profiles')
  if (!existsSync(root)) return []
  const out = []
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) continue
    try {
      const m = JSON.parse(readFileSync(pkgFile, 'utf8'))
      if (Array.isArray(m?.dsh?.profile?.bundles)) out.push({ name, dir, manifest: m })
    } catch { /* 坏掉的 profile 跳过，别拖累别人 */ }
  }
  return out
}

/** 插件包自检：缺 ./client 出口 = 那台 DSH 起不来 */
export function checkBundle(dir = PLUGIN_DIR) {
  const problems = []
  let pkg = null
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch (e) { problems.push(`package.json 读不了：${e.message}`) }
  if (pkg) {
    if (!pkg.exports?.['.']) problems.push('package.json 缺 exports["."]')
    if (pkg.dsh?.client) {
      // 导出可以是精确子路径，也可以是 `./locale/*.json` 这种通配
      const hasExport = (sub) => {
        if (pkg.exports?.[sub]) return pkg.exports[sub]
        for (const k of Object.keys(pkg.exports || {})) {
          if (!k.includes('*')) continue
          const re = new RegExp('^' + k.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$')
          if (re.test(sub)) return sub.replace(/^\.\//, '')
        }
        return null
      }
      for (const sub of ['./client', './icon', './locale/zh.json', './locale/en.json']) {
        const target = hasExport(sub)
        if (!target) { problems.push(`缺 exports["${sub}"]`); continue }
        const file = String(target).replace(/^\.\//, '')
        if (!existsSync(join(dir, file))) problems.push(`exports["${sub}"] 指向的文件不存在：${file}`)
      }
    }
    const patch = pkg?.dsh?.bundle?.patch
    if (!patch) problems.push('package.json 缺 dsh.bundle.patch')
    else {
      const pf = join(dir, patch)
      if (!existsSync(pf)) problems.push(`dsh.bundle.patch 指向的文件不存在：${patch}`)
      else {
        const body = readFileSync(pf, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n')
        if (!body.trimStart().startsWith('- insert:')) problems.push('cordis.patch.yml 不是合法的 - insert: 数组')
        const re = new RegExp(`name:\\s*${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
        if (!re.test(body)) problems.push(`cordis.patch.yml 里没有 name: ${pkg.name}`)
      }
    }
    for (const f of ['index.js', 'client.js']) if (!existsSync(join(dir, f))) problems.push(`缺 ${f}`)
  }
  return { ok: problems.length === 0, problems, pkg }
}

/** 把本包登记进一个 profile：链接 + dependencies(link:) + bundles */
export function installProfile({ dir, dry = false, log = () => {} }) {
  const pkgFile = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(pkgFile, 'utf8'))
  const nm = join(dir, 'node_modules')
  const link = join(nm, NAME)
  const spec = `link:${posix(PLUGIN_DIR)}`

  let linked = false
  try { linked = !!lstatSync(link) } catch { linked = false }
  if (!linked) {
    if (dry) log(`  · [dry] 会建链接 → ${posix(link)}`)
    else {
      mkdirSync(nm, { recursive: true })
      try {
        symlinkSync(PLUGIN_DIR, link, process.platform === 'win32' ? 'junction' : 'dir')
        log(`  · 链接建好 → ${posix(link)}`)
      } catch (e) { log(`  · ⚠️ 建链接失败（${e?.message ?? e}）—— 插件库可能看不到它`) }
    }
  } else log(`  · 链接已存在（${NAME}）`)

  const changed = []
  manifest.dependencies = manifest.dependencies || {}
  if (manifest.dependencies[NAME] !== spec) { manifest.dependencies[NAME] = spec; changed.push('dependencies') }
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return { ok: false, why: '这个 profile 没有 dsh.profile.bundles', changed }
  if (!bundles.includes(NAME)) { bundles.push(NAME); changed.push('bundles') }

  if (!dry && changed.length) {
    try { copyFileSync(pkgFile, `${pkgFile}.bak-music-player`) } catch { /* 备份失败也继续 */ }
    writeFileSync(pkgFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    try { JSON.parse(readFileSync(pkgFile, 'utf8')) } catch (e) {
      copyFileSync(`${pkgFile}.bak-music-player`, pkgFile)
      return { ok: false, why: `写坏了 package.json，已自动还原：${e.message}`, changed }
    }
    log(`  · 已登记：${changed.join(' + ')}`)
  } else if (!changed.length) log('  · 依赖与 bundles 都已登记')
  return { ok: true, changed }
}

/** 摘掉（不动用户 patch —— 我们本来就没往里写） */
export function uninstallProfile({ dir, dry = false, log = () => {} }) {
  const pkgFile = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(pkgFile, 'utf8'))
  const changed = []
  if (manifest.dependencies?.[NAME]) { delete manifest.dependencies[NAME]; changed.push('dependencies') }
  const bundles = manifest?.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(NAME)) {
    manifest.dsh.profile.bundles = bundles.filter((b) => b !== NAME)
    changed.push('bundles')
  }
  if (!dry && changed.length) {
    copyFileSync(pkgFile, `${pkgFile}.bak-music-player`)
    writeFileSync(pkgFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  }
  const link = join(dir, 'node_modules', NAME)
  if (!dry) {
    try { unlinkSync(link); log('  · 链接已删') } catch { /* 没链接就算了 */ }
  }
  log(changed.length ? `  · 已摘除：${changed.join(' + ')}` : '  · 本来就没装')
  return { ok: true, changed }
}

/** 装完/卸完回读 */
export function verifyProfile({ dir }) {
  const pkgFile = join(dir, 'package.json')
  const out = []
  try {
    const m = JSON.parse(readFileSync(pkgFile, 'utf8'))
    out.push({ ok: (m?.dsh?.profile?.bundles || []).includes(NAME), why: 'bundles 里在', what: 'bundles' })
    out.push({ ok: !!m?.dependencies?.[NAME], why: 'dependencies 里在', what: 'dependencies' })
  } catch (e) { out.push({ ok: false, why: `package.json 读不了：${e.message}`, what: 'package.json' }) }
  try { out.push({ ok: !!lstatSync(join(dir, 'node_modules', NAME)), why: 'node_modules 链接在', what: 'link' }) }
  catch { out.push({ ok: false, why: 'node_modules 链接不在', what: 'link' }) }
  return out
}

const SELF_FILE = fileURLToPath(import.meta.url)
const isMain = !!process.argv[1] && resolve(process.argv[1]) === resolve(SELF_FILE)

if (isMain) {
  const argv = process.argv.slice(2)
  const dry = argv.includes('--dry')
  const verifyOnly = argv.includes('--verify-only')
  const uninstall = argv.includes('--uninstall')
  const pIdx = argv.indexOf('--profiles')
  const want = pIdx >= 0 ? String(argv[pIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null
  const log = (...a) => console.log(...a)

  const home = detectHome()
  log(`插件目录：${posix(PLUGIN_DIR)}`)
  log(`DSH_HOME：${posix(home)}`)

  const self = checkBundle()
  if (!self.ok) {
    log('\n❌ 插件包自身不自洽，先别装：')
    for (const p of self.problems) log(`   · ${p}`)
    process.exit(1)
  }
  log('✓ 包清单自洽（bundle patch / ./client / icon / locale 都在）')

  const all = listProfiles(home)
  if (!all.length) {
    log(`\n⚠️ ${posix(home)} 下没有找到 DSH profile。`)
    log('   DSH 装在别处时先设 DSH_HOME，例如 Windows：set DSH_HOME=C:\\Users\\你\\.dsh')
    log('   macOS / Linux：export DSH_HOME=~/.dsh')
    process.exit(1)
  }
  const targets = want ? all.filter((p) => want.includes(p.name)) : all
  log(`\n发现 ${all.length} 个 profile：${all.map((p) => p.name).join(', ')}`)
  if (want && !targets.length) { log('⚠️ --profiles 指定的名字一个都没匹配上'); process.exit(1) }

  if (verifyOnly) {
    let bad = 0
    for (const pr of targets) {
      // 只装了其中一部分 profile 是合法的（比如本机用插件管理器只装 desktop）。
      // 所以：装了的必须完全正确；没装的不算错，只提示一句。
      const v = verifyProfile(pr)
      const installed = v.some((r) => r.ok)
      log(`\n[${pr.name}]`)
      if (!installed) {
        log('  · 没装（跳过）')
        continue
      }
      for (const r of v) { if (!r.ok) bad++; log(`  ${r.ok ? '✓' : '✗'} ${r.why}`) }
    }
    process.exit(bad ? 1 : 0)
  }

  let bad = 0
  for (const pr of targets) {
    log(`\n[${pr.name}]`)
    const r = uninstall
      ? uninstallProfile({ dir: pr.dir, dry, log })
      : installProfile({ dir: pr.dir, dry, log })
    if (!r.ok) { log(`  ⚠️ ${r.why}`); bad++; continue }
    if (!dry && !uninstall) {
      for (const v of verifyProfile({ dir: pr.dir })) { if (!v.ok) { bad++; log(`  ✗ ${v.why}`) } }
      if (bad === 0) log('  ✓ 安装后自检通过')
    }
  }

  log('\n完成。')
  if (uninstall) {
    log('  · 生效：重启一次 DSH')
  } else {
    log('  · 生效：**重启一次 DSH**（bundles 是启动时组合的）')
    log('  · 验证：左侧图标条多一个「音乐」；点开后主工作区是播放器')
    log('  · 设置页：设置 → 「音乐播放器」可调均衡器 / DSD / 缓冲')
  }
  process.exit(bad ? 1 : 0)
}
