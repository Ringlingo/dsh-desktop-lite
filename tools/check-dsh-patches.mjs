#!/usr/bin/env node
/**
 * check-dsh-patches.mjs —— 便携包「脱离源码树的补丁」体检
 *
 * 背景：本项目的可移植性修复有一部分必须落在**便携包**里（dsh 的安装文件、profile 清单、
 * 镜像、插件实体），它们不在壳源码树中，因此没有版本管理。换包/升级 dsh 后极容易被覆盖。
 *
 * 这个脚本只做**只读体检**：逐项检查补丁是否在位，并打印 PASS/FAIL 与处置指引。
 * 它不改任何文件 —— 需要重新打补丁时，按每项给出的文档章节操作。
 *
 * 用法：
 *   node tools/check-dsh-patches.mjs --root <便携包根目录>
 *   node tools/check-dsh-patches.mjs              # 默认取本仓库上一级若存在 runtime/ 与 data/
 *   退出码：0 = 全部在位；1 = 有缺失项
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 解析便携包根目录：优先 --root，其次自下而上找同时含 runtime/ 与 data/ 的目录。 */
function resolveRoot() {
  const i = process.argv.indexOf('--root');
  if (i >= 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  let dir = HERE;
  for (let n = 0; n < 8; n += 1) {
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
    if (fs.existsSync(path.join(dir, 'runtime')) && fs.existsSync(path.join(dir, 'data'))) return dir;
  }
  return null;
}

const ROOT = resolveRoot();
if (ROOT === null) {
  console.error('找不到便携包根目录（应同时含 runtime/ 与 data/）。请用 --root <路径> 指定。');
  process.exit(2);
}

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
};
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** 每个补丁项：id / 说明 / 期望命中的片段 / 缺失时的处置指引（指向文档章节）。 */
const CHECKS = [
  {
    id: 'dsh:module-fallback-form',
    what: 'dsh-app-boot：镜像条目默认走「代理目录」形态（真实目录，ZIP 友好、不需建链接能力）',
    file: 'runtime/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
    needs: ['DSH_MODULE_FALLBACK'],
    doc: 'docs/fix-plan-2026-09-16.md §6（S2）',
  },
  {
    id: 'dsh:proxy-tolerance',
    what: 'dsh-app-boot：proxy 生成失败时跳过该条目，不拖垮整条依赖闭包',
    file: 'runtime/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
    needs: ['return [];'],
    optional: true,
    doc: 'docs/fix-plan-2026-09-16.md §6（S2 容错）',
  },
  {
    id: 'dsh:proxy-manifest-carryover',
    what: 'dsh-app-boot：proxy 清单携带源包字段（否则 dsh.client 扫描看不到客户端模块 ⇒ 插件加载失败）',
    file: 'runtime/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
    needs: ['sourceManifest'],
    doc: 'docs/fix-plan-2026-09-16.md §9',
  },
  {
    id: 'dsh:client-entry-copy',
    what: 'dsh-app-boot：./client 子路径复制真实文件（经典脚本），不能写成 ESM 再导出',
    file: 'runtime/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
    needs: ['=== "./client"'],
    doc: 'docs/fix-plan-2026-09-16.md §10',
  },
  {
    id: 'plugin:root-resolution',
    what: 'dsh-runtime-inspector：分层解析应用根目录（否则报「请先运行 provision-runtimes」）',
    file: 'data/plugins/dsh-runtime-inspector/lib/index.js',
    needs: ['function resolveRoot'],
    doc: 'docs/fix-plan-2026-09-16.md §14',
  },
  {
    id: 'plugin:runtime-icon',
    what: '设置页「运行时」使用独立图标（否则与「通用」同为默认齿轮）',
    file: 'runtime/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js',
    needs: ['id === "runtime"'],
    doc: 'docs/fix-plan-2026-09-16.md §17',
  },
  {
    id: 'profile:no-link-deps',
    what: 'profile 清单不再声明 link: 依赖（插件实体改为内置，避免受限环境建链接失败）',
    file: 'data/profiles/web/package.json',
    absent: ['"link:'],
    doc: 'docs/fix-plan-2026-09-16.md §6（S2b）',
  },
  {
    id: 'plugin:builtin-both-places',
    what: '插件实体两处齐备（profile 内供解析 + 安装内供自检判据）',
    multi: [
      'data/profiles/web/node_modules/tabbit-browser/package.json',
      'data/profiles/web/node_modules/dsh-runtime-inspector/package.json',
      'runtime/dsh/node_modules/tabbit-browser/package.json',
      'runtime/dsh/node_modules/dsh-runtime-inspector/package.json',
    ],
    doc: 'docs/fix-plan-2026-09-16.md §6（S2b）',
  },
  {
    id: 'mirror:managed-proxy',
    what: '镜像由 dsh 托管代理目录构成（不是 junction ⇒ ZIP 无损、换机不需建链接权限）',
    dir: 'data/profiles/node_modules',
    doc: 'docs/fix-plan-2026-09-16.md §6 §12',
  },
  {
    id: 'shell:selfcheck-proxy-aware',
    what: '自检脚本认「代理目录」（否则每次启动都会把它们当物化移出）',
    file: 'data/downloads/startup-selfcheck.mjs',
    needs: ['isManagedProxy'],
    doc: 'docs/fix-plan-2026-09-16.md §7（S1）',
  },
  {
    id: 'tuning:no-currency-icon',
    what: '壳源码不含余额前的人民币图标（转义写法也算）',
    repoFile: 'src-tauri/ui/shell-inject.js',
    absent: ['\\u00A5', '\u00A5', '\uFFE5'],
    doc: 'docs/fix-plan-2026-09-16.md §15',
  },
];

function checkItem(item) {
  if (item.repoFile !== undefined) {
    // 检查项指向**壳源码树**（相对本脚本的仓库根），而非便携包内
    const text = (() => {
      try {
        return fs.readFileSync(path.join(HERE, '..', item.repoFile), 'utf8');
      } catch {
        return null;
      }
    })();
    if (text === null) return { ok: false, detail: '源码树内文件不存在：' + item.repoFile };
    const found = (item.absent ?? []).filter((s) => text.includes(s));
    return { ok: found.length === 0, detail: found.length === 0 ? '未出现' : '仍含 ' + JSON.stringify(found) };
  }
  if (Array.isArray(item.multi)) {
    const missing = item.multi.filter((rel) => !exists(rel));
    return { ok: missing.length === 0, detail: missing.length === 0 ? '全部在位' : '缺失 ' + missing.join('、') };
  }
  if (item.dir) {
    if (!exists(item.dir)) return { ok: false, detail: '目录不存在：' + item.dir };
    let proxies = 0;
    let links = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) {
          links += 1;
          continue;
        }
        if (e.isDirectory()) {
          if (fs.existsSync(path.join(p, 'entry-0.js'))) proxies += 1;
          else if (path.dirname(p) === d) walk(p);
        }
      }
    };
    walk(path.join(ROOT, item.dir));
    const ok = proxies > 50 && links === 0;
    return { ok, detail: `代理目录 ${proxies} 个 · 链接 ${links} 条（期望：代理 > 50 且链接 = 0）` };
  }
  const text = read(item.file);
  if (text === null) return { ok: false, detail: '文件不存在：' + item.file };
  if (Array.isArray(item.absent)) {
    const found = item.absent.filter((s) => text.includes(s));
    return { ok: found.length === 0, detail: found.length === 0 ? '未出现' : '仍含 ' + JSON.stringify(found) };
  }
  const missing = (item.needs ?? []).filter((s) => !text.includes(s));
  return { ok: missing.length === 0, detail: missing.length === 0 ? '命中' : '缺少标记 ' + JSON.stringify(missing) };
}

console.log('便携包根目录: ' + ROOT + '\n');
let failed = 0;
for (const item of CHECKS) {
  const { ok, detail } = checkItem(item);
  if (!ok && !item.optional) failed += 1;
  const tag = ok ? 'PASS' : item.optional ? 'SKIP' : 'FAIL';
  console.log(`[${tag}] ${item.id}`);
  console.log(`       ${item.what}`);
  console.log(`       → ${detail}`);
  if (!ok) console.log(`       → 处置指引：${item.doc}`);
}
console.log('\n合计：' + CHECKS.length + ' 项，未通过 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);
