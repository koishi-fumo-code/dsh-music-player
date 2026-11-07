#!/usr/bin/env node
/**
 * scripts/simulate-foreign-pc.mjs —— 造一台「假电脑」，从解压到卸载全走一遍
 * ============================================================================
 * 目的：证明确实能在**别的电脑**上跑，而不是只在这台机器上碰巧能用。
 *
 * 假世界怎么造：
 *   · 把插件包拷到一个临时目录（模拟「对方解压到哪里」）
 *   · 临时 DSH_HOME（模拟对方的 C:\Users\xxx\.dsh）
 *   · 一个只有 dsh.profile.bundles 的干净 profile
 *   · 全程不碰真实的 %USERPROFILE%\.dsh
 *
 * 断言覆盖：
 *   ① 包自检通过（patch / exports / icon / locale）
 *   ② 安装后 bundles + dependencies + 链接都对
 *   ③ 依赖指向的是**假电脑的路径**，不是打包机的 D:\dsh工作区
 *   ④ 幂等：再装一次不炸、不重复
 *   ⑤ 用户 cordis.patch.yml 没被写过
 *   ⑥ 卸载干净（bundles / dependencies / 链接）
 *   ⑦ client.js 能真跑（mock 浏览器，验槽位登记）
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NAME = pkg.name

let pass = 0, fail = 0
const ok = (c, label, detail = '') => {
  if (c) { pass++; console.log(`  [OK]   ${label}`) }
  else { fail++; console.log(`  [FAIL] ${label}${detail ? ' —— ' + detail : ''}`) }
}

const SANDBOX = join(tmpdir(), 'dsh-music-foreign-' + Date.now())
const FOREIGN = join(SANDBOX, 'Downloads', NAME)   // 「对方解压到哪」
const HOME = join(SANDBOX, '.dsh')                 // 「对方的 DSH_HOME」
const PROF = join(HOME, 'profiles', 'desktop')
const posix = (p) => String(p).replace(/\\/g, '/')

console.log(`\n假电脑：${posix(SANDBOX)}\n`)

try {
  console.log('① 把插件拷到「对方的下载目录」')
  {
    mkdirSync(FOREIGN, { recursive: true })
    // files 白名单里可能有 `locale/*.json` 这种通配，按 glob 展开再拷
    const expand = (pat) => {
      if (!pat.includes('*')) return [pat]
      const dir = pat.slice(0, pat.lastIndexOf('/'))
      const suffix = pat.slice(pat.lastIndexOf('/') + 1).replace('*', '')
      const abs = join(ROOT, dir)
      if (!existsSync(abs)) return []
      return readdirSync(abs)
        .filter((n) => n.endsWith(suffix))
        .map((n) => `${dir}/${n}`)
    }
    const items = new Set([...(pkg.files || []), 'package.json', 'install.cmd', 'install.ps1'])
    for (const pat of items) {
      for (const item of expand(pat)) {
        const src = join(ROOT, item)
        if (!existsSync(src)) continue
        cpSync(src, join(FOREIGN, item), { recursive: true })
      }
    }
    ok(existsSync(join(FOREIGN, 'package.json')), '插件文件拷过去了')
    ok(existsSync(join(FOREIGN, 'client.js')), 'client.js 在')
    ok(existsSync(join(FOREIGN, 'locale', 'zh.json')), 'locale/zh.json 在')
    ok(!existsSync(join(FOREIGN, 'node_modules')), '没带 node_modules')
  }

  console.log('\n② 造一个干净的 DSH profile')
  {
    mkdirSync(PROF, { recursive: true })
    writeFileSync(join(PROF, 'package.json'), JSON.stringify({
      name: 'desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, null, 2) + '\n', 'utf8')
    // 对方的 cordis.patch.yml（装了别的插件），要证明我们不碰它
    writeFileSync(join(PROF, 'cordis.patch.yml'), `# user's own patch\n- insert:\n    - id: someone-else\n      name: some-other-plugin\n`, 'utf8')
    ok(existsSync(join(PROF, 'package.json')), 'profile 建好了')
  }

  const env = { ...process.env, DSH_HOME: HOME }
  const run = (script, args = []) => {
    try {
      return execFileSync(process.execPath, [join(FOREIGN, script), ...args], {
        env, stdio: 'pipe', encoding: 'utf8',
      })
    } catch (e) {
      // 失败时把安装器自己的输出打出来，不然只看到一句 "Command failed"
      console.log('  --- install 输出 ---')
      console.log(String(e.stdout || '').trim() || '(no stdout)')
      console.log('  --- install 错误 ---')
      console.log(String(e.stderr || '').trim() || '(no stderr)')
      throw e
    }
  }

  console.log('\n③ 跑安装器')
  {
    const out = run('scripts/install.mjs')
    ok(out.includes('包清单自洽'), '包自检通过')
    ok(out.includes('安装后自检通过'), '安装后自检通过')
    const m = JSON.parse(readFileSync(join(PROF, 'package.json'), 'utf8'))
    ok(m.dsh.profile.bundles.includes(NAME), 'bundles 里登记了')
    ok(!!m.dependencies[NAME], 'dependencies 里登记了')
    ok(existsSync(join(PROF, 'node_modules', NAME)), 'node_modules 链接建好了')
  }

  console.log('\n④ 依赖指向假电脑的路径（没绑死打包机）')
  {
    const m = JSON.parse(readFileSync(join(PROF, 'package.json'), 'utf8'))
    const spec = m.dependencies[NAME]
    ok(spec.startsWith('link:'), '依赖是 link: 形式', spec)
    ok(posix(spec).includes(posix(HOME)) || posix(spec).includes(posix(SANDBOX)), '指向假电脑的临时目录', spec)
    ok(!posix(spec).includes('dsh工作区'), '没有指向打包机的 D:\\dsh工作区', spec)
    // 链接能读到包内容（不是死链）
    ok(existsSync(join(PROF, 'node_modules', NAME, 'client.js')), '通过链接能读到 client.js')
  }

  console.log('\n⑤ 幂等：再装一次')
  {
    const out = run('scripts/install.mjs')
    ok(out.includes('都已登记') || out.includes('链接已存在'), '重复安装不报错')
    const m = JSON.parse(readFileSync(join(PROF, 'package.json'), 'utf8'))
    const count = m.dsh.profile.bundles.filter((b) => b === NAME).length
    ok(count === 1, 'bundles 里没有重复项', String(count))
  }

  console.log('\n⑥ 没碰用户的 cordis.patch.yml')
  {
    const body = readFileSync(join(PROF, 'cordis.patch.yml'), 'utf8')
    ok(body.includes('someone-else'), '用户原有的内容还在')
    ok(!body.includes(NAME), '我们没有往里写东西')
  }

  console.log('\n⑦ client.js 在「对方机器上」能真跑')
  {
    let loaded = null
    globalThis.window = { __ModuleLoader__: { load(cfg) { loaded = cfg } } }
    globalThis.document = { createElement() { return { setAttribute() {}, textContent: '', remove() {} } }, head: { appendChild() {} } }
    globalThis.URL = { createObjectURL() { return 'blob:x' }, revokeObjectURL() {} }
    globalThis.Blob = class { constructor(p, o) { this.type = o?.type || '' } }
    globalThis.localStorage = { _m: {}, getItem() { return null }, setItem() {} }
    globalThis.Audio = class { constructor() { this.volume = 1 } addEventListener() {} play() { return Promise.resolve() } pause() {} load() {} removeAttribute() {} }

    const React = {
      createElement: (type, props, ...c) => ({ $$el: true, type, props: props || {}, children: c }),
      useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
      useEffect() {}, useRef: (v) => ({ current: v ?? null }), useCallback: (f) => f,
    }
    const requireShim = (n) => { if (n === 'react') return React; throw new Error('unexpected require: ' + n) }

    const src = readFileSync(join(PROF, 'node_modules', NAME, 'client.js'), 'utf8')
    const fn = new Function('window', 'document', 'URL', 'Blob', 'Audio', 'localStorage', 'require', 'console', 'TextDecoder', src)
    fn(globalThis.window, globalThis.document, globalThis.URL, globalThis.Blob, globalThis.Audio, globalThis.localStorage, requireShim, console, TextDecoder)
    ok(!!loaded && loaded.id === NAME, '模块自注册成功')

    const regs = []
    const mod = loaded.factory(requireShim)
    mod.apply({
      get: (k) => (k === 'slots' ? { inject(n, cb) { regs.push({ n, d: cb() }); return () => {} }, register(o, c) { return { o, c } } } : undefined),
      effect: (f) => { try { const d = f(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
    })
    const names = regs.map((r) => r.n)
    for (const need of ['main', 'sidebar.panellist', 'settings.section']) {
      ok(names.includes(need), `登记了 ${need}`)
    }
    const tree = regs.find((r) => r.n === 'main').d.c().type()
    ok(tree && tree.type === 'div', '播放面板能 render')
  }

  console.log('\n⑧ 卸载干净')
  {
    run('scripts/install.mjs', ['--uninstall'])
    const m = JSON.parse(readFileSync(join(PROF, 'package.json'), 'utf8'))
    ok(!m.dsh.profile.bundles.includes(NAME), 'bundles 里没了')
    ok(!m.dependencies[NAME], 'dependencies 里没了')
    ok(!existsSync(join(PROF, 'node_modules', NAME)), '链接删掉了')
    const body = readFileSync(join(PROF, 'cordis.patch.yml'), 'utf8')
    ok(body.includes('someone-else'), '用户的 patch 依然没被动')
  }
} catch (e) {
  ok(false, '模拟过程中出异常', String(e?.message ?? e).split('\n')[0])
} finally {
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

console.log(`\n${fail === 0 ? '通过' : '失败'}：${pass} 条通过，${fail} 条失败`)
if (fail) {
  console.log('\n⇒ 有红项：别人装上去会坏，先别发。')
  process.exit(1)
}
console.log('\n⇒ 换台电脑能跑。可以分发了。')
