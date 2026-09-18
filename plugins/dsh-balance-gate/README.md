# dsh-balance-gate

让壳标题栏里的「余额」胶囊**只在当前会话跑在 DeepSeek 上时出现**，其他模型下隐藏。

## 为什么需要它

壳（`dsh-desktop-lite.exe`）的注入脚本 `ui/shell-inject.js` 里，`discoverProvider()` 请求的是
同源 `/api/host.describe` —— 这条路径**在 dsh 原生是 404、在壳桥上命中「未知路由」**，
壳桥的路由表里根本没有它。所以 `state.provider` 恒为 `null`，
`refreshBalance()` 永远用兜底值 `"deepseek-official"` 去查余额：

```
provider = state.providerManual && select.value ? select.value : state.provider  // → undefined
if (!provider) provider = "deepseek-official"                                    // → 永远是它
```

于是只要你用的不是 DeepSeek，那个胶囊就一直是「余额 --」/ 报错，纯噪音。

而这段脚本是 `include_str!("../ui/shell-inject.js")` **编译进 exe** 的 ——
改磁盘上的 `ui/shell-inject.js` 运行时不生效，且现役 exe 对应的那份新源码已丢失
（磁盘上的壳源码是更旧的版本，重编译会退化 UI）。所以只能在运行时从客户端打补丁。

## 判定规则

与壳桥 `src-tauri/src/quota.rs` 的 `is_deepseek_provider` **完全一致**：

```rust
provider.to_ascii_lowercase().starts_with("deepseek")
```

即 `provider.trim().toLowerCase().startsWith("deepseek")` → 算 DeepSeek，显示余额；
否则隐藏。provider 未知时**不隐藏**（宁可多显示，也不误隐藏）。

## 两半的职责

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| 宿主 | `lib/index.js` | 只读路由 `GET /dsh-balance-gate/api`：读 `data/settings.yaml` 的 `agent-default-model.provider`，作为**兜底**来源；同时充当 bundle 的装载锚点 |
| 客户端 | `lib/client.js` | 解析当前 provider → 决定显隐 → 落到壳的 DOM 上；轮询 1000ms |

## provider 取法（按准确性排序）

1. **会话级（权威）**
   ```js
   ctx.get("sessions").list.getSnapshot().current              // 当前会话 id
   ctx.get("modelDirectories").directoryFor(id)
      .store.getSnapshot().current.provider                    // 当前会话实际 provider
   ```
   这是 composer 模型座与 `/model` 弹窗**共用**的那份状态（`ModelDirectory`），
   所以等价于「现在到底在用哪个模型」，而不是「默认模型」。
2. **兜底**：`GET /dsh-balance-gate/api` → `settings.defaultProvider`（带 30s TTL 异步缓存）。
3. 都拿不到 → 不隐藏。

## 显隐落点

- 标题栏胶囊 `#dshp-bal`
- 控制台「操作」页余额行 `#kv-bal` 及其左侧 `dt` 标签

两者都是壳用 `eval` 在页面加载后（800/2500/5000/8000ms 重试）注入的，
所以每个轮询周期都重试一遍；隐藏用 `.dshbg-hidden{display:none !important}` 压过壳的内联样式。

## 排查

DevTools 控制台：

```js
__DSH_BALANCE_GATE__.state
// → { provider, source, isDeepseek, hidden, targetsBound, ticks, lastTickAt }
```

`source` 是 `session` / `settings-default` / `unknown`，一眼看出走的是哪条路径。

## 挂载方式（照 `tabbit-browser` 范式）

1. `data/profiles/web/package.json`
   - `dsh.profile.bundles` 加 `"dsh-balance-gate"`
   - `dependencies` 加 `"dsh-balance-gate": "link:../../plugins/dsh-balance-gate"`
2. 建 junction：`data/profiles/web/node_modules/dsh-balance-gate` → `data/plugins/dsh-balance-gate`

```bash
node data/downloads/_diag/link-plugin-junction.mjs --root . --plugin dsh-balance-gate
```

## 回滚

```bash
# 1) 摘掉 junction
node data/downloads/_diag/link-plugin-junction.mjs --root . --plugin dsh-balance-gate --remove
# 2) 从 data/profiles/web/package.json 里删掉 bundles 与 dependencies 两处条目
#    （备份：data/backups/profiles-web-package.json.before-balance-gate）
```

## 注意

`ctx.modelDirectories` / `ctx.sessions` 是 dsh 客户端的**内部服务**（非公开 API）。
dsh 升级后若服务名或快照结构变化，会话级取法会失效 —— 届时应表现为
`source` 变成 `settings-default`（自动降级，不会报错）。规则本身只依赖壳桥的
前缀判定，不受影响。
