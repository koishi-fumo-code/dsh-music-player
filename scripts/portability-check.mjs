#!/usr/bin/env node
/**
 * scripts/portability-check.mjs —— 发之前自检：有没有把本机绑死
 * ============================================================================
 * 只查「换台电脑会坏」的东西，不查风格：
 *   · 源码里不许出现写死的绝对路径（D:\ / C:\Users\ / /Users/ / /home/）
 *   · 不许 require 任何 @deepseek-ai/* 或第三方包（桌面 profile autoInstallPeers:false，
 *     裸 import peer 会让整条插件不激活）
 *   · package.json 的 exports / files / dsh 字段必须自洽
 *   · 不许带 node_modules / dist / .stage / 备份文件进分发
 *   · 中文注释不能出现在 .cmd/.ps1（PowerShell 5.1 按 GBK 读会乱码）
 * ============================================================================
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

let pass = 0, fail = 0
const ok = (c, label, detail = '') => {
  if (c) { pass++; console.log(`  [OK]   ${label}`) }
  else { fail++; console.log(`  [FAIL] ${label}${detail ? ' —— ' + detail : ''}`) }
}

const walk = (dir, out = []) => {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.stage' || n === 'dist' || n === '.git') continue
    const p = join(dir, n)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

console.log('\n① 源码里没有写死本机路径')
{
  const files = walk(ROOT).filter((f) => /\.(js|mjs|json|yml|yaml|svg|md)$/.test(f))
  const bad = []
  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, '/')
    if (rel.startsWith('scripts/')) continue // 脚本里提到路径有注释性质，不参与运行
    const src = readFileSync(f, 'utf8')
    // 找真正的路径字面量：D:\xxx、C:\Users\xxx、/Users/xxx、/home/xxx
    const hits = src.match(/(?<![A-Za-z])(?:[A-Za-z]:\\\\|C:\\\\Users|\/Users\/|\/home\/)[^\s'"`)]{2,}/g)
    if (hits) bad.push(`${rel}: ${hits.slice(0, 2).join(' , ')}`)
  }
  // README 里提到来源路径是说明文字，允许；只对运行文件严格
  const runtimeBad = bad.filter((b) => !b.startsWith('README'))
  ok(runtimeBad.length === 0, '运行文件里没有本机绝对路径', runtimeBad.join(' | '))
}

console.log('\n② 零运行时依赖')
{
  const deps = Object.keys(pkg.dependencies || {})
  const peer = Object.keys(pkg.peerDependencies || {})
  ok(deps.length === 0, '没有 dependencies', deps.join(','))
  ok(peer.length === 0, '没有 peerDependencies', peer.join(','))
  const code = ['client.js', 'index.js'].map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n')
  const reqs = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const imports = [...code.matchAll(/^\s*import\s+[^'"]*from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  const allowed = new Set(['react', 'node:path', 'node:fs', 'node:os', 'node:url'])
  const badReqs = [...reqs, ...imports].filter((r) => !allowed.has(r) && !r.startsWith('.'))
  ok(badReqs.length === 0, '只 require react / node: 内建模块', badReqs.join(','))
}

console.log('\n③ 包清单自洽')
{
  ok(typeof pkg.name === 'string' && pkg.name.length > 0, 'name 有值')
  ok(pkg.type === 'module', 'type: module（client.js 是自注册脚本，index.js 是 ESM）')
  ok(!!pkg.exports?.['.'], '有 exports["."]')
  ok(!!pkg.exports?.['./client'], '有 exports["./client"]')
  for (const sub of ['./icon', './locale/zh.json', './locale/en.json']) {
    const target = pkg.exports?.[sub]
    // `./locale/*.json` 这种通配导出也算覆盖
    const wildcard = Object.keys(pkg.exports || {}).find((k) => {
      if (!k.includes('*')) return false
      const re = new RegExp('^' + k.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$')
      return re.test(sub)
    })
    ok(!!target || !!wildcard, `有 exports["${sub}"]`, wildcard ? `（走通配 ${wildcard}）` : '')
    if (target) ok(existsSync(join(ROOT, String(target).replace(/^\.\//, ''))), `  ${sub} 指向的文件存在`)
    else if (wildcard) ok(existsSync(join(ROOT, sub.replace(/^\.\//, ''))), `  ${sub} 实际文件存在`)
  }
  ok(!!pkg.dsh?.bundle?.patch, '有 dsh.bundle.patch')
  ok(existsSync(join(ROOT, pkg.dsh?.bundle?.patch || 'x')), '  patch 文件存在')
  ok(!!pkg.dsh?.client, '有 dsh.client')
  ok(pkg.dsh?.client?.platform === 'web', '  client.platform = web')
  // files 白名单要覆盖所有运行需要的文件
  const need = ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/zh.json', 'locale/en.json']
  const files = pkg.files || []
  const covered = (f) => files.some((pat) => {
    if (pat === f) return true
    // `locale/*.json` 覆盖 locale/zh.json
    if (pat.includes('*')) {
      const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      return re.test(f)
    }
    return false
  })
  ok(need.every(covered), 'files 白名单覆盖全部运行文件', need.filter((f) => !covered(f)).join(','))
}

console.log('\n④ locale 元信息完整')
{
  for (const loc of ['zh', 'en']) {
    const f = join(ROOT, 'locale', `${loc}.json`)
    if (!existsSync(f)) { ok(false, `${loc}.json 存在`); continue }
    const j = JSON.parse(readFileSync(f, 'utf8'))
    ok(!!j?.meta?.title, `${loc}.json 有 meta.title`)
    ok(!!j?.meta?.description, `${loc}.json 有 meta.description`)
  }
  const icon = readFileSync(join(ROOT, 'icon.svg'))
  ok(icon.length > 0 && icon.length < 256 * 1024, 'icon.svg 大小合规（<256KiB）')
  ok(icon.toString('utf8', 0, 5).includes('<svg') || icon.toString('utf8').includes('<svg'), 'icon.svg 是 SVG')
}

console.log('\n⑤ 分发时不带脏东西')
{
  const junk = walk(ROOT).filter((f) => /\.bak-|\.tgz$|\.log$/.test(f))
  ok(junk.length === 0, '没有备份 / 旧包 / 日志', junk.map((f) => relative(ROOT, f)).join(','))
  ok(!existsSync(join(ROOT, 'node_modules')), '没有 node_modules')
  ok(!existsSync(join(ROOT, '.stage')), '没有 .stage')
}

console.log('\n⑥ 启动器脚本纯 ASCII（避免 PowerShell 5.1 中文乱码）')
{
  for (const f of ['install.cmd', 'install.ps1']) {
    const p = join(ROOT, f)
    if (!existsSync(p)) { ok(false, `${f} 存在`); continue }
    const buf = readFileSync(p)
    const nonAscii = buf.some((b) => b > 0x7f)
    ok(!nonAscii, `${f} 是全 ASCII`)
  }
}

console.log(`\n${fail === 0 ? '通过' : '失败'}：${pass} 条通过，${fail} 条失败`)
if (fail) {
  console.log('\n⇒ 有红项就别分发：换台电脑会坏。')
  process.exit(1)
}
console.log('\n⇒ 可以打包分发了：node scripts/make-tgz.mjs')
