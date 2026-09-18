// startup-selfcheck.mjs — 启动自检 + 自修复（**唯一实现**）。
//
// 定位：这是「数据层健康」的唯一权威检查器。两个消费者：
//   1) 壳（内嵌此脚本，spawn 后端**之前**跑一次）—— 见 src-tauri/src/startup_check.rs
//   2) 手动入口（_tools/selfcheck.cmd，`--dry-run` 只报告）
//
// 为什么需要它：本包数据层用 junction 组织（0.1.5 共 481+ 条）。凡「会解引用链接」的
// 复制/打包/解压方式（zip 往返、部分同步盘、GUI 跨盘复制）都会把 junction 摊平成真实
// 目录；dsh 的 dsh-app-boot 的 ensureSymlink() 只接受「符号链接」或「带
// dsh.moduleFallback.targets 记录的托管代理」，真实目录直接抛错 → 后端起不来 →
// 应用卡在加载页。另外 dsh-atomic-write 的孤儿锁同样会阻塞启动。
//
// 不变量（健康安装下这些位置**必须是链接或不存在**，绝不能是真实目录）：
//   A  data/profiles/node_modules/**                         dsh 会重建
//   B  data/profiles/web/.dsh-module-fallback/node_modules/** dsh 会重建
//   C  data/profiles/web/node_modules/<清单里声明的包>          dsh 会重建
//   D  data/profiles/.packages/<pkg>/node_modules/<peer>      **dsh 不重建，本脚本重建**
//
// 修复语义：A/B/C 的物化条目「改名移出」到 ROOT/_backup/materialized-<ts>/，交给 dsh 重建；
//           D 直接建成指向 runtime 安装内同名包的 junction；悬空链接删掉让 dsh 重建；
//           data/*.lock 里持有者已退出的孤儿锁删掉；manifest 里写死的绝对 link: 改成相对。
//
// 输出协议（供壳解析）：
//   SC|step|<文本>            进度
//   SC|result|<单行 JSON>     最终结果（壳据此决定是否放行 spawn）
// 人类可读输出照常打印，另有报告落盘 data/logs/startup-selfcheck.{json,txt}。
//
// 用法：
//   node startup-selfcheck.mjs [--root <dir>] [--dry-run] [--quiet]
//                              [--require-app-stopped] [--backup <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null };
const DRY = has('--dry-run');
const QUIET = has('--quiet');
const REQUIRE_STOPPED = has('--require-app-stopped');

const log = (m = '') => { if (!QUIET) console.log(m) };
const ok = (m) => log('  [ok]   ' + m);
const warn = (m) => log('  [warn] ' + m);
const bad = (m) => log('  [bad]  ' + m);
const step = (m) => { console.log('SC|step|' + m) };

// ── 定位根目录 ────────────────────────────────────────────────────────────
function findRoot() {
  const isRoot = (d) => fs.existsSync(path.join(d, 'runtime', 'node', 'node.exe')) && fs.existsSync(path.join(d, 'data'));
  const argRoot = valOf('--root');
  if (argRoot) {
    const r = path.resolve(argRoot);
    if (!isRoot(r)) { console.error('SC|fatal|--root 不像应用根目录: ' + r); process.exit(2) }
    return r;
  }
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let n = 0; n < 8; n++) {
    if (isRoot(d)) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  console.error('SC|fatal|找不到应用根目录（应含 runtime/node/node.exe 与 data/）');
  process.exit(2);
}

const ROOT = findRoot();
const DATA = path.join(ROOT, 'data');
const INST = path.join(ROOT, 'runtime', 'dsh', 'node_modules');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const BAK = valOf('--backup') ? path.resolve(valOf('--backup')) : path.join(ROOT, '_backup', 'materialized-' + STAMP);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// ── 结果累积 ──────────────────────────────────────────────────────────────
const R = {
  ts: new Date().toISOString(), root: ROOT, dryRun: DRY, backupDir: BAK,
  locks: { found: 0, removed: 0, keptLive: 0 },
  materialized: { found: 0, moved: [] },
  dangling: { found: 0, removed: [] },
  aliases: { rebuilt: [] },
  manifest: { fixed: [] },
  selfNested: [],
  unrepairable: [],
  linksTotal: 0,
  managedProxy: { found: 0 },
  ok: true,
};

// ── 基础工具 ──────────────────────────────────────────────────────────────
function kind(p) {
  try { const s = fs.lstatSync(p); return s.isSymbolicLink() ? 'link' : (s.isDirectory() ? 'dir' : 'file') }
  catch { return 'missing' }
}
function isDangling(p) {
  try {
    const s = fs.lstatSync(p);
    if (!s.isSymbolicLink()) return false;
    return !fs.existsSync(path.resolve(path.dirname(p), fs.readlinkSync(p)));
  } catch { return false }
}

/** ⭐ 真实目录且是 dsh 托管的「代理目录」⇒ 合法形态，**不是物化**。
 *
 *  dsh 在 pkg 模式（或本包打了 DSH_MODULE_FALLBACK=proxy 补丁）下，用
 *  「真实目录 + package.json 里的 dsh.moduleFallback.targets + entry-N.js」
 *  代替 junction 来表达镜像条目（见 dsh-app-boot 的 moduleFallbackEntryCurrent）。
 *
 *  自检必须认这种形态：否则每次启动都会把代理目录判为物化、移出到 _backup，
 *  再由 dsh 全量重建 —— 净负收益（实测：411 条每次启动反复搬移）。
 */
function isManagedProxy(p) {
  try {
    if (!fs.lstatSync(p).isDirectory()) return false;
    const m = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8'));
    const t = m && m.dsh && m.dsh.moduleFallback && m.dsh.moduleFallback.targets;
    if (!t || typeof t !== 'object') return false;
    return Object.keys(t).every((_, i) => fs.existsSync(path.join(p, 'entry-' + i + '.js')));
  } catch { return false }
}
function moveOut(p) {
  const dest = path.join(BAK, rel(p).replace(/[\\/]/g, '__'));
  if (DRY) { R.materialized.moved.push(rel(p)); return true }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(p, dest);
    R.materialized.moved.push(rel(p));
    return true;
  } catch (e) {
    R.unrepairable.push({ path: rel(p), why: '移出失败: ' + (e.code || e.message) });
    return false;
  }
}
function dropLink(p) {
  if (DRY) { R.dangling.removed.push(rel(p)); return true }
  try { fs.unlinkSync(p); R.dangling.removed.push(rel(p)); return true }
  catch (e) { R.unrepairable.push({ path: rel(p), why: '删除悬空链接失败: ' + (e.code || e.message) }); return false }
}
function makeJunction(target, link) {
  if (DRY) { R.aliases.rebuilt.push(rel(link) + ' -> ' + rel(target)); return true }
  try {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (kind(link) !== 'missing') fs.unlinkSync(link);
    fs.symlinkSync(target, link, 'junction');
    R.aliases.rebuilt.push(rel(link) + ' -> ' + rel(target));
    return true;
  } catch (e) {
    R.unrepairable.push({ path: rel(link), why: '建链接失败: ' + (e.code || e.message) });
    return false;
  }
}
function scopePackages(modulesDir) {
  // 返回 [{name, full}]，展开 @scope/pkg。
  // 注意：include symlinks —— 悬空 junction 的 isDirectory() 是 false，
  // 若只按 isDirectory 过滤会把"最需要修的那一类"整段跳过。
  const out = [];
  let es; try { es = fs.readdirSync(modulesDir, { withFileTypes: true }) } catch { return out }
  for (const e of es) {
    const p = path.join(modulesDir, e.name);
    if (e.name.startsWith('@')) {
      let kids; try { kids = fs.readdirSync(p, { withFileTypes: true }) } catch { continue }
      for (const c of kids) out.push({ name: e.name + '/' + c.name, full: path.join(p, c.name) });
    } else if ((e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.')) {
      out.push({ name: e.name, full: p });
    }
  }
  return out;
}

// ── 0. 前置：应用是否在运行（手工调用时更安全；壳调用时不需要）─────────────
if (REQUIRE_STOPPED) {
  step('检查应用是否在运行');
  let procs = null;
  try {
    procs = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', maxBuffer: 1 << 27 });
  } catch {}
  if (procs && /"dsh-desktop-lite\.exe"/i.test(procs)) {
    bad('应用仍在运行 —— 请先完全退出（含托盘）');
    R.ok = false;
    R.unrepairable.push({ path: '(app)', why: '应用正在运行，拒绝改动数据层' });
    finish();
  }
  ok('应用未在运行');
}

// ── 1. 孤儿锁 ─────────────────────────────────────────────────────────────
step('检查写入锁');
{
  let locks = [];
  try { locks = fs.readdirSync(DATA).filter((f) => f.endsWith('.lock')) } catch {}
  R.locks.found = locks.length;
  let procs = null;
  try { procs = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', maxBuffer: 1 << 27 }) } catch {}
  for (const f of locks) {
    const p = path.join(DATA, f);
    let raw = '';
    try { raw = fs.readFileSync(p, 'utf8').trim() } catch {}
    const pid = /^\d+$/.test(raw) ? raw : null;
    const alive = pid !== null && procs !== null && new RegExp('"' + pid + '"').test(procs);
    if (alive) { warn('保留活锁 ' + f + '（pid ' + pid + ' 仍在运行）'); R.locks.keptLive++; continue }
    if (procs === null) { warn('保留 ' + f + '（无法确认持有者，保守不动）'); R.locks.keptLive++; continue }
    if (DRY) { log('  将删孤儿锁 ' + f + '（pid ' + (pid ?? '?') + ' 已退出）'); R.locks.removed++; continue }
    try { fs.rmSync(p, { force: true }); ok('清理孤儿锁 ' + f); R.locks.removed++ }
    catch (e) { R.unrepairable.push({ path: 'data/' + f, why: '删锁失败: ' + (e.code || e.message) }) }
  }
  if (locks.length === 0) ok('无残留锁');
}

// ── 2~4. 物化 / 悬空 / 声明依赖 ────────────────────────────────────────────
//
// ⚠️ 关键区别（实测踩过坑，别再搞反）：
//    A 镜像 / B fallback —— dsh 会重建，**删掉悬空链接即可**
//    C profile 声明依赖 —— dsh 的 bundle 解析（prepareProfile → loadProfile → resolveBundleDir）
//      发生在它自己的自愈（composeProfile 后段的 healProfilesModuleFallback）**之前**，
//      所以这里【删掉就等于让启动失败】（报 cannot resolve profile bundle），
//      **必须自己重建**链接。
//    D 外挂插件 peer 别名 —— dsh 完全不管，必须自建。

/** 解析某个包在本包内的实体目录。linkSpec 形如 `link:../.packages/xxx` 或 `link:../../plugins/xxx`。 */
function resolveEntityDir(profileDir, name, linkSpec) {
  if (typeof linkSpec === 'string' && linkSpec.startsWith('link:')) {
    const abs = path.resolve(profileDir, linkSpec.slice(5));
    if (fs.existsSync(path.join(abs, 'package.json'))) return abs;
  }
  const base = (typeof linkSpec === 'string' && linkSpec.startsWith('link:')
    ? path.basename(linkSpec.slice(5).replace(/[\\/]+$/, ''))
    : null) || name.split('/').pop();
  for (const c of [path.join(DATA, 'plugins', base), path.join(DATA, 'profiles', '.packages', base)]) {
    if (fs.existsSync(path.join(c, 'package.json'))) return c;
  }
  return null;
}

/** 收集各 profile 清单里声明的包（bundles + dependencies）——C 段判据与目标来源。 */
function declaredProfilePackages() {
  const out = [];
  const dir = path.join(DATA, 'profiles');
  let profs = [];
  try { profs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')) } catch {}
  for (const pr of profs) {
    const pdir = path.join(dir, pr.name);
    let m; try { m = JSON.parse(fs.readFileSync(path.join(pdir, 'package.json'), 'utf8')) } catch { continue }
    const deps = m.dependencies || {};
    const names = new Set([...(m.dsh?.profile?.bundles || []), ...Object.keys(deps)]);
    for (const name of names) out.push({ profileDir: pdir, name, linkSpec: deps[name] });
  }
  return out;
}

function sweepLinksOnly(modulesDir, label) {
  // A/B：所有包条目必须是链接（或缺失）；真实目录 → 物化
  let es; try { es = fs.readdirSync(modulesDir, { withFileTypes: true }) } catch { return }
  for (const e of es) {
    const p = path.join(modulesDir, e.name);
    const k = kind(p);
    if (k === 'file' || k === 'missing') continue;          // 元数据文件留在原地
    if (e.name.startsWith('@') && k === 'dir') {
      for (const c of fs.readdirSync(p, { withFileTypes: true })) {
        const cp = path.join(p, c.name);
        const ck = kind(cp);
        if (ck === 'link') { R.linksTotal++; if (isDangling(cp)) { R.dangling.found++; dropLink(cp) } continue }
        if (ck === 'missing') continue;
        if (isManagedProxy(cp)) { R.managedProxy.found++; continue }
        R.materialized.found++;
        moveOut(cp);
      }
      continue;
    }
    if (k === 'link') { R.linksTotal++; if (isDangling(p)) { R.dangling.found++; dropLink(p) } continue }
    if (isManagedProxy(p)) { R.managedProxy.found++; continue }
    R.materialized.found++;
    moveOut(p);
  }
  if (R.materialized.found === 0) ok(label + '：结构正常');
}

/** C 段：区分「内置 bundle」与「外挂插件」，语义完全不同。
 *
 *  - `bundles` 里有、但 `dependencies` 里**没有 link:** → 内置 bundle，由 dsh 从
 *    `runtime/dsh/node_modules` 解析。**不要求在 profile 里存在链接**，只校验安装内能解析到。
 *  - `dependencies[*] = link:...` → 外挂插件实体。**必须**在 profile 的 node_modules 里
 *    以链接形式存在，缺了就自己建 —— dsh 的 bundle 解析等不到它的自愈。
 *  - 其它（pnpm 自管）→ 只清悬空。
 */
function sweepDeclared(profileDir, declared, label) {
  const modulesDir = path.join(profileDir, 'node_modules');
  const isLinkSpec = (d) => typeof d.linkSpec === 'string' && d.linkSpec.startsWith('link:');
  const linked = declared.filter(isLinkSpec);
  const inbox = declared.filter((d) => !isLinkSpec(d));
  const linkedNames = new Set(linked.map((d) => d.name));
  const inboxNames = new Set(inbox.map((d) => d.name));
  const byName = new Map(linked.map((d) => [d.name, d]));
  const seen = new Set();
  let rebuilt = 0, unresolved = 0;

  // 1) 内置 bundle：只校验安装内可解析
  let inboxBad = 0;
  for (const d of inbox) {
    const found = fs.existsSync(path.join(INST, d.name, 'package.json'))
      || fs.existsSync(path.join(INST, '@deepseek-ai', d.name, 'package.json'));
    if (!found) {
      R.unrepairable.push({ path: label + '/' + d.name, why: '内置 bundle 在 runtime/dsh 安装内解析不到' });
      inboxBad++;
    }
  }
  if (inbox.length) {
    ok(label + '：内置 bundle ' + inbox.length + ' 个' + (inboxBad ? '，其中 ' + inboxBad + ' 个解析不到' : '，全部可在安装内解析'));
  }

  // 2) 现有条目
  const rebuild = (name) => {
    const d = byName.get(name);
    const full = path.join(modulesDir, ...name.split('/'));
    const target = resolveEntityDir(profileDir, name, d.linkSpec);
    if (!target) {
      R.unrepairable.push({
        path: rel(full),
        why: '外挂插件 ' + name + ' 找不到本地实体（link: ' + d.linkSpec + '）',
      });
      unresolved++;
      return;
    }
    if (makeJunction(target, full)) rebuilt++;
  };

  for (const { name, full } of scopePackages(modulesDir)) {
    const k = kind(full);
    if (inboxNames.has(name)) {                       // 内置 bundle 的条目：不碰
      if (k === 'link') R.linksTotal++;
      continue;
    }
    if (!linkedNames.has(name)) {                     // pnpm 自管：只清悬空
      if (k === 'link') { R.linksTotal++; if (isDangling(full)) { R.dangling.found++; dropLink(full) } }
      continue;
    }
    seen.add(name);
    R.linksTotal++;
    const d = byName.get(name);
    const target = resolveEntityDir(profileDir, name, d.linkSpec);
    if (!target) {
      R.unrepairable.push({ path: rel(full), why: '外挂插件 ' + name + ' 找不到本地实体（link: ' + d.linkSpec + '）' });
      unresolved++;
      continue;
    }
    if (isManagedProxy(full)) { R.managedProxy.found++; continue }
    if (k === 'dir') {
      R.materialized.found++;
      if (!moveOut(full)) continue;                   // 移出后重建
    } else if (k === 'link') {
      let cur = null;
      try { cur = path.resolve(path.dirname(full), fs.readlinkSync(full)) } catch {}
      const dang = isDangling(full);
      if (cur && cur.toLowerCase() === target.toLowerCase() && !dang) continue;   // 已经对了
      if (dang) { R.dangling.found++; if (!dropLink(full)) continue }
      else { try { fs.unlinkSync(full) } catch {} }
    }
    if (makeJunction(target, full)) rebuilt++;
  }

  // 3) 外挂插件声明了但目录里根本没有 → 必须建出来
  for (const d of linked) {
    if (seen.has(d.name)) continue;
    R.linksTotal++;
    rebuild(d.name);
  }

  ok(label + '：外挂插件 ' + linked.length + ' 个' + (rebuilt ? '，重建链接 ' + rebuilt : '')
    + (unresolved ? '，无法定位 ' + unresolved + ' 个' : ''));
}

step('检查 A 镜像 data/profiles/node_modules');
sweepLinksOnly(path.join(DATA, 'profiles', 'node_modules'), 'A 镜像');

step('检查 B profile-owned fallback');
sweepLinksOnly(path.join(DATA, 'profiles', 'web', '.dsh-module-fallback', 'node_modules'), 'B fallback');

step('检查 C profile 声明依赖');
{
  const all = declaredProfilePackages();
  const byProfile = new Map();
  for (const d of all) {
    if (!byProfile.has(d.profileDir)) byProfile.set(d.profileDir, []);
    byProfile.get(d.profileDir).push(d);
  }
  for (const [pdir, list] of byProfile) sweepDeclared(pdir, list, 'C ' + path.basename(pdir));
  if (byProfile.size === 0) ok('C：未找到任何 profile 清单');
}

step('检查 D 外挂插件 peer 别名');
{
  const pk = path.join(DATA, 'profiles', '.packages');
  let pkgs = [];
  try { pkgs = fs.readdirSync(pk, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')) } catch {}
  let checked = 0;
  for (const e of pkgs) {
    const mods = path.join(pk, e.name, 'node_modules');
    let children = [];
    try { children = fs.readdirSync(mods, { withFileTypes: true }) } catch { continue }
    for (const c of children) {
      if (c.name.startsWith('@') || c.name.startsWith('.')) continue;
      const link = path.join(mods, c.name);
      const k = kind(link);
      if (k === 'link' && !isDangling(link)) { R.linksTotal++; continue }
      // 目标：runtime 安装里的同名作用域包优先，其次同名顶层包
      const t1 = path.join(INST, '@deepseek-ai', c.name);
      const t2 = path.join(INST, c.name);
      const target = fs.existsSync(path.join(t1, 'package.json')) ? t1 : (fs.existsSync(path.join(t2, 'package.json')) ? t2 : null);
      if (target === null) {
        R.unrepairable.push({ path: rel(link), why: '安装内找不到同名包，无法重建' });
        continue;
      }
      if (isManagedProxy(link)) { R.managedProxy.found++; continue }
      if (k === 'dir') { R.materialized.found++; if (!moveOut(link)) continue }
      checked++;
      makeJunction(target, link);
    }
  }
  ok('D 别名：检查 ' + pkgs.length + ' 个外挂包' + (checked ? '，重建 ' + checked + ' 条' : ''));
}

// ── 5. profile manifest 写死的绝对 link: ──────────────────────────────────
// 换机/搬家后绝对路径必然失效，而 link: 的语义只是"指向本地插件实体"。
// 所以解析顺序：相对且可解析 → 保持；否则按 basename 在本包的已知实体位置里找，
// 找到就改写成相对路径。找不到才放弃（不致命）。
function resolveLinkTarget(profileDir, name, raw) {
  const abs = path.resolve(profileDir, raw);
  if (!/^[A-Za-z]:/.test(raw) && fs.existsSync(path.join(abs, 'package.json'))) {
    return { path: abs, reason: '相对路径可用' };
  }
  const hit = resolveEntityDir(profileDir, name, 'link:' + raw);
  if (hit) return { path: hit, reason: '按实体名重新定位' };
  return null;
}

step('检查 profile manifest 的 link: 声明');
{
  const dir = path.join(DATA, 'profiles');
  let profs = [];
  try { profs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')) } catch {}
  let changed = 0, unresolved = 0;
  for (const pr of profs) {
    const pdir = path.join(dir, pr.name);
    const mp = path.join(pdir, 'package.json');
    let m; try { m = JSON.parse(fs.readFileSync(mp, 'utf8')) } catch { continue }
    let dirty = false;
    for (const [name, spec] of Object.entries(m.dependencies || {})) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue;
      const raw = spec.slice(5);
      const hit = resolveLinkTarget(pdir, name, raw);
      if (!hit) { warn(pr.name + ': ' + name + ' 找不到实体（' + raw + '），保留原样'); unresolved++; continue }
      const r = path.relative(pdir, hit.path).split(path.sep).join('/');
      const next = 'link:' + (r.startsWith('.') ? r : './' + r);
      if (next === spec) continue;                       // 已经是对的，不动
      m.dependencies[name] = next;
      dirty = true; changed++;
      R.manifest.fixed.push(pr.name + ': ' + name + '  ' + spec + '  ->  ' + next + '  (' + hit.reason + ')');
    }
    if (dirty && !DRY) {
      try { fs.writeFileSync(mp, JSON.stringify(m, void 0, 2) + '\n') }
      catch (e) { R.unrepairable.push({ path: rel(mp), why: '写入失败: ' + (e.code || e.message) }) }
    }
  }
  if (changed === 0 && unresolved === 0) ok('无写死绝对路径');
  else if (changed) ok('修正 ' + changed + ' 条 link: 声明');
}

// ── 6. 目录自嵌套检测（连续同名目录 ≥3 次）────────────────────────────────
// 实测案例：注入器实体里出现过 injector/injector/… 连 822 层、最深路径 7463 字符
// （MAX_PATH 的 28 倍），成因是「一次把目录复制进自身的递归复制」被路径长度挡停。
// 它不影响启动（运行时并不引用），但会让资源管理器 / rmdir / zip / 部分 robocopy 失败，
// 也会让每次整包复制白带一堆目录 —— 所以要**早点发现**。
//
// 刻意做成「只告警、不自动删」：同一名字连续出现虽反常，但自动批量删除属于破坏性动作，
// 不该由启动路径悄悄执行。发现后给人话指引，由人来决定。
step('检查目录自嵌套（异常结构）');
{
  const NEST_MIN = 3;        // 连续同名 ≥3 次即视为异常
  const DEPTH_MAX = 30;      // 深度上限：健康的 data/ 远不到这个深度
  const NODE_CAP2 = 40000;   // 节点上限：保证启动不被拖慢
  const SKIP = new Set(['backups', 'logs', 'downloads']);
  const found = [];
  let nodes = 0, truncated = false;

  (function w(dir, depth, chain) {
    if (depth > DEPTH_MAX) return;
    if (nodes > NODE_CAP2) { truncated = true; return }
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      if (++nodes > NODE_CAP2) { truncated = true; return }
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      let st; try { st = fs.lstatSync(p) } catch { continue }
      if (st.isSymbolicLink()) continue;                  // 绝不跟随链接
      const last = chain[chain.length - 1];
      if (last === e.name) {
        const run = chain.slice().reverse().findIndex((x) => x !== e.name);
        const times = (run === -1 ? chain.length : run) + 1;
        if (times >= NEST_MIN) {
          found.push({ path: rel(p), times });
          continue;                                       // 已判定异常，不再往下（省时间）
        }
      }
      w(p, depth + 1, [...chain, e.name].slice(-6));
    }
  })(DATA, 0, [path.basename(DATA)]);

  R.selfNested = found;
  if (found.length === 0) ok('未发现连续同名目录' + (truncated ? '（遍历已达上限，结论可能不完整）' : ''));
  else {
    warn('发现 ' + found.length + ' 处目录自嵌套（典型成因：一次「把目录复制进自身」的递归复制）');
    for (const f of found.slice(0, 5)) log('      ' + f.path + '   连续同名 ×' + f.times);
    if (found.length > 5) log('      ... 其余 ' + (found.length - 5) + ' 处');
    log('      处理：把该目录整体「改名移出」后删除。路径可能远超 MAX_PATH，');
    log('            请用 Node（fs.rmSync）等支持长路径的方式，**不要用资源管理器或 rmdir /s**。');
  }
}

// ── 收尾 ──────────────────────────────────────────────────────────────────
function finish() {
  R.ok = R.unrepairable.length === 0 && R.locks.keptLive === 0;
  const summary = {
    ok: R.ok, dryRun: DRY,
    locksRemoved: R.locks.removed, locksKeptLive: R.locks.keptLive,
    materializedFound: R.materialized.found, materializedMoved: R.materialized.moved.length,
    danglingFound: R.dangling.found, danglingRemoved: R.dangling.removed.length,
    aliasesRebuilt: R.aliases.rebuilt.length,
    manifestFixed: R.manifest.fixed.length,
    unrepairable: R.unrepairable.length,
    linksTotal: R.linksTotal,
    managedProxyFound: R.managedProxy.found,          // ← 健康基线参考值 490；数量突变即说明数据层被动过
    selfNested: (R.selfNested || []).length,   // ← 目录自嵌套处数（>0 需要人工清理）
    backupDir: R.materialized.moved.length ? BAK : null,
  };
  console.log('SC|result|' + JSON.stringify(summary));

  // 报告落盘（dry-run 也写，便于比对；但标注 dryRun）
  try {
    const logs = path.join(DATA, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'startup-selfcheck.json'), JSON.stringify(R, null, 2) + '\n');
    const txt = [
      'startup-selfcheck 报告',
      '时间   : ' + R.ts,
      '根目录 : ' + ROOT,
      '模式   : ' + (DRY ? 'dry-run（未改动）' : '实际执行'),
      '',
      '── 结果 ──',
      '  孤儿锁     : 清理 ' + R.locks.removed + ' / 保留活锁 ' + R.locks.keptLive,
      '  物化条目   : 发现 ' + R.materialized.found + ' / 移出 ' + R.materialized.moved.length,
      '  代理目录   : ' + R.managedProxy.found + '（dsh 托管的 ESM 代理目录 —— 合法形态，不视为物化）',
      '  悬空链接   : 发现 ' + R.dangling.found + ' / 清理 ' + R.dangling.removed.length,
      '  别名重建   : ' + R.aliases.rebuilt.length,
      '  manifest   : 修正 ' + R.manifest.fixed.length,
      '  目录自嵌套 : ' + ((R.selfNested || []).length ? (R.selfNested || []).length + ' 处（需人工清理，见下）' : '未发现'),
      '  无法修复   : ' + R.unrepairable.length,
      '  链接总数   : ' + R.linksTotal + '（健康基线 490）',
      '',
      (R.selfNested || []).length
        ? '── 目录自嵌套 ──\n  ' + R.selfNested.slice(0, 10).map((f) => f.path + '  (连续同名 ×' + f.times + ')').join('\n  ')
        : '',
      R.materialized.moved.length ? '── 移出清单（前 40）──\n  ' + R.materialized.moved.slice(0, 40).join('\n  ') : '',
      R.unrepairable.length ? '── 无法修复 ──\n  ' + R.unrepairable.map((u) => u.path + '  ' + u.why).join('\n  ') : '',
      R.unrepairable.length && R.materialized.moved.length
        ? '\n提示：移出内容都在 ' + BAK + '，可按原相对路径原样搬回。' : '',
      '',
      '结论   : ' + (R.ok ? 'OK —— 数据层健康，可以启动' : 'FAILED —— 有无法自动修复的问题'),
    ].filter(Boolean).join('\n');
    fs.writeFileSync(path.join(logs, 'startup-selfcheck.txt'), txt + '\n');
  } catch {}

  log('');
  log('──────────────────────────────');
  if (DRY) log('dry-run：将清锁 ' + R.locks.removed + ' / 移出物化 ' + R.materialized.moved.length + ' / 清理悬空 ' + R.dangling.removed.length + ' / 重建别名 ' + R.aliases.rebuilt.length);
  else log('完成：清锁 ' + R.locks.removed + ' / 移出物化 ' + R.materialized.moved.length + ' / 清理悬空 ' + R.dangling.removed.length + ' / 重建别名 ' + R.aliases.rebuilt.length);
  if (R.unrepairable.length) {
    bad('无法修复 ' + R.unrepairable.length + ' 项：');
    for (const u of R.unrepairable.slice(0, 10)) log('    ' + u.path + '  ' + u.why);
  }
  log('结论: ' + (R.ok ? 'OK —— 数据层健康' : 'FAILED —— 需要人工处理'));
  process.exit(R.ok ? 0 : 1);
}

finish();
