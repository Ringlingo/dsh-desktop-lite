/**
 * dsh-balance-gate — 宿主半边（host half）
 *
 * 背景：壳（dsh-desktop-lite.exe）在标题栏里塞了一个「余额」胶囊，但它的 provider
 * 探测是**死代码**（请求同源 /api/host.describe，该路径在 dsh 与壳桥上都不存在），
 * 于是永远拿兜底值 "deepseek-official" 去查余额 —— 用非 DeepSeek 模型时就变成
 * 一个毫无意义的「余额 --」。而且这段注入脚本是 `include_str!` 编进 exe 的，
 * 改磁盘文件不生效，所以只能在运行时从客户端补丁修正。
 *
 * 判定规则与壳桥**完全一致**（src-tauri/src/quota.rs 的 is_deepseek_provider）：
 *   provider 去空白、转小写后以 "deepseek" 开头 → 才算 DeepSeek。
 *
 * 本半边提供：
 *   GET /dsh-balance-gate/api   →  { ok, rule, settings: {…}, decision: {…} }
 *
 * 客户端半边优先用会话级 provider（ctx.modelDirectories），拿不到时才回落到这里
 * 汇报的 settings 默认 provider。根目录由本文件物理位置反推（lib → 插件目录 →
 * plugins → data → 根目录），**不写死绝对路径**。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-balance-gate'

/** webServer 是硬依赖：没有它就无处挂路由，插件应等待而不是静默失效。 */
export const inject = ['webServer']

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** lib → 插件目录 → plugins → data → 应用根目录 */
const ROOT = path.resolve(HERE, '..', '..', '..', '..')
const SETTINGS = path.join(ROOT, 'data', 'settings.yaml')

/** 与壳桥 quota.rs 保持一致的判定规则。 */
export const RULE = 'provider.trim().toLowerCase().startsWith("deepseek")'

export function isDeepseekProvider(provider) {
  return typeof provider === 'string' && provider.trim().toLowerCase().startsWith('deepseek')
}

function unquote(value) {
  const s = String(value).trim()
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1)
  }
  return s
}

/**
 * 从 settings.yaml 里取 agent-default-model 的 provider / model。
 *
 * 只做「够用的 YAML 子集」解析，不引第三方依赖（插件目录不在 dsh 的
 * node_modules 解析祖先链上，import('yaml') 未必可用）：
 *   1. 块状写法：`agent-default-model:` 之下缩进更深的 `provider: x`
 *   2. 流式写法：`agent-default-model: {provider: x, model: y}`
 *   3. 兜底：全文件第一个 `  provider:` 行
 */
export function parseDefaultModel(text) {
  if (typeof text !== 'string' || text === '') return { provider: null, model: null, form: null }

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 只认顶层键，避免匹配到别处缩进里的同名键
    if (!/^agent-default-model\s*:/.test(line)) continue

    const inline = line.slice(line.indexOf(':') + 1).trim()

    if (inline.startsWith('{')) {
      const found = {}
      for (const part of inline.replace(/^\{/, '').replace(/\}$/, '').split(',')) {
        const idx = part.indexOf(':')
        if (idx < 0) continue
        found[part.slice(0, idx).trim()] = unquote(part.slice(idx + 1))
      }
      return { provider: found.provider ?? null, model: found.model ?? null, form: 'flow' }
    }

    const found = {}
    for (let j = i + 1; j < lines.length; j++) {
      const inner = lines[j]
      if (inner.trim() === '' || inner.trim().startsWith('#')) continue
      if (/^\S/.test(inner)) break // 回到顶层键，块结束
      const m = /^\s+(provider|model)\s*:\s*(.*)$/.exec(inner)
      if (m) found[m[1]] = unquote(m[2])
    }
    return { provider: found.provider ?? null, model: found.model ?? null, form: 'block' }
  }

  const fallback = /^\s+provider\s*:\s*(.*)$/m.exec(text)
  return { provider: fallback ? unquote(fallback[1]) : null, model: null, form: fallback ? 'fallback' : null }
}

/** 读取 settings.yaml 并给出默认 provider 判定（只读，不缓存，保证实时）。 */
export function snapshot() {
  let readable = false
  let error = null
  let parsed = { provider: null, model: null, form: null }

  try {
    parsed = parseDefaultModel(fs.readFileSync(SETTINGS, 'utf8'))
    readable = true
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }

  return {
    ok: true,
    schema: 1,
    generatedAt: new Date().toISOString(),
    rule: RULE,
    settings: {
      path: path.relative(ROOT, SETTINGS).replace(/\\/g, '/'),
      readable,
      defaultProvider: parsed.provider,
      defaultModel: parsed.model,
      parsedForm: parsed.form,
      error,
    },
    decision: {
      provider: parsed.provider,
      isDeepseek: isDeepseekProvider(parsed.provider),
      source: 'settings-default',
    },
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

  if (pathname === '/dsh-balance-gate/api' || pathname === '/dsh-balance-gate/api/') {
    try {
      sendJson(response, 200, snapshot())
    } catch (cause) {
      sendJson(response, 500, { ok: false, error: cause instanceof Error ? cause.message : String(cause) })
    }
    return
  }

  sendJson(response, 404, { ok: false, error: 'not found', path: pathname })
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/dsh-balance-gate', handler }),
    'balance-gate: /dsh-balance-gate/api route',
  )
  if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') {
    ctx.logger.info('balance-gate: route ready at /dsh-balance-gate/api (root=%s)', ROOT)
  }
}
