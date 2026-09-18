/**
 * dsh-runtime-inspector — 宿主半边（host half）
 *
 * 在 dsh 宿主进程里注册一条**只读** HTTP 路由，把「便携包自带的三个运行时」
 * (node / python / git) 的真实状态汇报给 Web 设置页：
 *
 *   GET /runtime-inspector/api   →   JSON 快照
 *
 * 数据来源：<根目录>/runtime/runtimes.json（由 provision-runtimes.mjs 生成）。
 * 根目录由本文件的物理位置反推（lib → 插件目录 → plugins → data → 根目录），
 * 因此**不写死任何绝对路径**，整包搬移/换盘后依然可用。
 *
 * 之所以顺带汇报 process.env.PATH：这是验证「启动器注入的 PATH 是否真的透传到了
 * dsh 后端进程」的唯一可靠手段——壳是它自己拉起后端的，启动器无法直接看到那一步。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-runtime-inspector'

/** webServer 是硬依赖：没有它就无处挂路由，插件应等待而不是静默失效。 */
export const inject = ['webServer']

const HERE = path.dirname(fileURLToPath(import.meta.url))
/**
 * 解析应用根目录（分层，可靠性优先）。
 *
 * 旧实现只做「lib → 插件目录 → plugins → data → 根目录」的上溯 4 层，**只在插件位于
 * `<root>/data/plugins/<pkg>/lib` 时成立**。一旦插件被放到
 * `<profile>/node_modules/<pkg>/lib`（Node 的 ESM 解析链需要）或
 * `<root>/runtime/dsh/node_modules/<pkg>/lib`，上溯 4 层就会指错目录，读不到
 * `runtime/runtimes.json`（表现为"请先运行 provision-runtimes"）。
 *
 * 依次尝试：① `DSH_HOME` 的父目录；② 自下而上找同时含 `runtime/` 与 `data/` 的目录；
 * ③ 退回原来的上溯 4 层。
 */
function resolveRoot() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) {
    const parent = path.dirname(path.resolve(home))
    if (fs.existsSync(path.join(parent, 'runtime'))) return parent
  }
  let dir = HERE
  for (let i = 0; i < 8; i += 1) {
    const next = path.dirname(dir)
    if (next === dir) break
    dir = next
    if (fs.existsSync(path.join(dir, 'runtime')) && fs.existsSync(path.join(dir, 'data'))) return dir
  }
  return path.resolve(HERE, '..', '..', '..', '..')
}
const ROOT = resolveRoot()
const MANIFEST = path.join(ROOT, 'runtime', 'runtimes.json')

/** 内置运行时清单（顺序即设置页展示顺序）。 */
const RUNTIMES = [
  { id: 'node', label: 'Node.js', args: ['--version'] },
  { id: 'python', label: 'Python', args: ['--version'] },
  { id: 'git', label: 'Git', args: ['--version'] },
]

function toPosix(value) {
  return value.replace(/\\/g, '/')
}

function relativeToRoot(absolute) {
  return toPosix(path.relative(ROOT, absolute))
}

function readManifest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
    return {
      readable: true,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
      schema: parsed.schema ?? null,
      runtimes: parsed.runtimes ?? {},
      error: null,
    }
  } catch (error) {
    return {
      readable: false,
      generatedAt: null,
      schema: null,
      runtimes: {},
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 当前进程可见的 PATH 条目（原样保留，用于诊断）。 */
function pathEntries() {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
}

function probe(executable, args) {
  try {
    const result = spawnSync(executable, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
      cwd: ROOT,
    })
    const first = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\r?\n/)[0] ?? ''
    const code = result.status === null ? -1 : result.status
    return { ok: code === 0 && first !== '', text: first, code }
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error), code: -1 }
  }
}

function humanSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return null
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/** 组装设置页要的完整快照（纯 JSON，可安全序列化）。 */
export function snapshot() {
  const manifest = readManifest()
  const normalizedPath = pathEntries().map((entry) => path.resolve(entry).toLowerCase())

  const runtimes = RUNTIMES.map(({ id, label, args }) => {
    const declared = manifest.runtimes[id]
    if (declared === undefined || declared === null) {
      return {
        id,
        label,
        present: false,
        reason: manifest.readable ? 'runtimes.json 未声明该运行时' : '找不到 runtime/runtimes.json（请先运行 provision-runtimes）',
      }
    }

    const relativeExe = typeof declared.executablePath === 'string' ? declared.executablePath : ''
    const absoluteExe = relativeExe === '' ? '' : path.join(ROOT, relativeExe)
    const exists = absoluteExe !== '' && fs.existsSync(absoluteExe)
    const directory = relativeExe === '' ? '' : path.dirname(absoluteExe)
    const directoryOnPath = exists && normalizedPath.includes(path.resolve(directory).toLowerCase())
    const probed = exists ? probe(absoluteExe, args) : null

    return {
      id,
      label,
      present: true,
      builtin: declared.builtin === true,
      source: typeof declared.source === 'string' ? declared.source : null,
      version: typeof declared.version === 'string' ? declared.version : null,
      versionRaw: typeof declared.versionRaw === 'string' ? declared.versionRaw : null,
      executablePath: relativeExe,
      absolutePath: absoluteExe,
      installPath: typeof declared.installPath === 'string' ? declared.installPath : null,
      size: typeof declared.size === 'number' ? declared.size : null,
      sizeText: humanSize(declared.size),
      installedAt: typeof declared.installedAt === 'string' ? declared.installedAt : null,
      exists,
      directoryOnPath,
      directory: relativeExe === '' ? null : relativeToRoot(directory),
      probeOk: probed !== null && probed.ok,
      probeText: probed === null ? null : probed.text,
      probeCode: probed === null ? null : probed.code,
    }
  })

  return {
    ok: true,
    schema: 1,
    generatedAt: new Date().toISOString(),
    root: ROOT,
    pid: process.pid,
    platform: process.platform,
    nodeVersion: process.version,
    manifest: {
      path: relativeToRoot(MANIFEST),
      readable: manifest.readable,
      generatedAt: manifest.generatedAt,
      error: manifest.error,
    },
    pathReport: {
      totalEntries: normalizedPath.length,
      injectedDirs: runtimes
        .filter((runtime) => runtime.present && runtime.exists && runtime.directory !== null)
        .map((runtime) => runtime.directory),
      onPath: runtimes.filter((runtime) => runtime.directoryOnPath).map((runtime) => runtime.id),
      missing: runtimes
        .filter((runtime) => runtime.present && runtime.exists && runtime.directory !== null && !runtime.directoryOnPath)
        .map((runtime) => runtime.id),
    },
    runtimes,
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function handler(request, response) {
  let pathname
  try {
    pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    sendJson(response, 400, { ok: false, error: '无法解析请求 URL' })
    return
  }

  if (pathname === '/runtime-inspector/api' || pathname === '/runtime-inspector/api/') {
    try {
      sendJson(response, 200, snapshot())
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  sendJson(response, 404, { ok: false, error: 'not found', path: pathname })
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/runtime-inspector', handler }),
    'runtime-inspector: /runtime-inspector/api route',
  )
  if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') {
    ctx.logger.info('runtime-inspector: route ready at /runtime-inspector/api (root=%s)', ROOT)
  }
}
