# 换包 / 升级后：如何恢复全部修复

> 本项目有相当一部分修复**不在源码树里**，而是落在**便携包**（dsh 安装、profile 清单、镜像、插件实体）和 **exe** 上。
> 一旦厂商换包或 dsh 升级，这些修复会被覆盖。本文是恢复清单。
> 完整根因与实测证据见 [`fix-plan-2026-09-16.md`](./fix-plan-2026-09-16.md)（§编号与下文对应）。

---

## 0. 一条命令体检

```powershell
# 用包内自带的 node
<包根>\runtime\node\node.exe tools\check-dsh-patches.mjs --root <包根>
```

- **exit 0** ⇒ 全部补丁在位
- **exit 1** ⇒ 逐项 FAIL，每项都会打印「处置指引：docs/fix-plan-2026-09-16.md §X」

---

## 1. 什么时候需要重新应用

| 场景 | 影响 |
| --- | --- |
| 厂商发来**新的便携包**（整体替换） | dsh 侧 + profile + 插件 + 镜像 **全部丢失**，需按 §2 重做 |
| **dsh 自身升级**（`update-dsh`） | 只丢 `runtime/dsh/**` 下的补丁（§2 第 1–4、6 项） |
| **壳重编**（`cargo build`） | 只影响 exe；但见 §3 的两个坑 |
| **换机/换路径** | 镜像会被 dsh 自动重建，属正常；见 §5 |

---

## 2. 逐项清单

| # | 项 | 位置 | 改什么 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | 镜像形态默认走**代理目录** | `runtime\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js` | 形态选择处默认取 proxy（`DSH_MODULE_FALLBACK` 标记） | §6（S2） |
| 2 | proxy 生成**容错** | 同上 | 单个包 proxy 生成失败时跳过，不拖垮整条闭包 | §6 |
| 3 | proxy 清单**携带源包字段** | 同上 | `ensureModuleProxy(..., sourceManifest)` + `dsh` 合并写入 | §9 |
| 4 | `./client` **复制真实文件** | 同上 | `./client` 子路径写经典脚本体，**不能**写 ESM 再导出 | §10 |
| 5 | 插件**分层解析根目录** | `data\plugins\dsh-runtime-inspector\lib\index.js` | `resolveRoot()`：`DSH_HOME` 父目录 → 上溯找含 `runtime/`+`data/` 的目录 → 兜底 | §14 |
| 6 | 设置页「运行时」**独立图标** | `runtime\dsh\node_modules\@deepseek-ai\dsh-client-ui-settings-general\lib\client.js` **和** `data\profiles\node_modules\@deepseek-ai\dsh-client-ui-settings-general\entry-1.js` | `navIcon()` 加 `if (id === "runtime") …`（两处都要改，后者才是被服务的那份） | §17 |
| 7 | profile **不再声明 `link:` 依赖** | `data\profiles\web\package.json` | `dependencies` 留空对象 | §6（S2b） |
| 8 | 插件实体**两处齐备** | `data\profiles\web\node_modules\{tabbit-browser,dsh-runtime-inspector}` **和** `runtime\dsh\node_modules\{同}` | 都是真实目录（本仓库 `plugins/` 下有副本） | §6（S2b） |
| 9 | 镜像为**托管代理目录** | `data\profiles\node_modules\**` | 由 dsh 生成；补丁生效后**删掉整个目录**让它重建一次 | §6 §12 |
| 10 | 自检脚本**认代理目录** | `data\downloads\startup-selfcheck.mjs` | 含 `isManagedProxy`（壳启动时会用内嵌副本重写它，源码在 `scripts/startup-selfcheck.mjs`） | §7（S1） |
| 11 | 余额**不带人民币图标** | `src-tauri\ui\shell-inject.js` | 金额前不放货币符号 span | §15 |

> 第 9 项的重建方式：删掉 `data\profiles\node_modules` 后**用非壳进程**跑一次 dsh
> （例如 `<包根>\runtime\node\node.exe <包根>\data\downloads\_diag\probe-home-sensitivity.mjs --root <包根>`），
> 它会按当前补丁重建 411 个代理目录。

---

## 3. 壳重编的两个坑（都踩过）

1. **改 `ui/index.html` 后必须 `touch src-tauri/build.rs`**
   否则 cargo 只做 1.4 秒的"假编译"，**前端资源不会重新内嵌**（cargo 不追踪 `frontendDist` 里的文件）。
2. **先 diff 两版 `ui/shell-inject.js` 与 `ui/index.html` 再重编**
   这两处被"重编用回旧版"覆盖过两次：加载页 `splash-status` 状态行、余额前的人民币图标。
   换包或重编前，先把厂商版与本地版 diff 一遍，把小改动捞回来。

---

## 4. 发行前检查

- ⚠️ **脱敏放在最后一步**：任何一次启动（壳或 dsh）都会**重建**
  `data\.credentials.yaml`（本机会话密钥）、`data\.anonymous-user-id`（设备 UUID）、`data\logs\*`（含回环 token）
- 可安全删除（省体积、更干净）：
  - `data\downloads\_diag\`（一次性排障脚本，运行时零依赖）
  - `data\backups\`（dsh 升级前的安装备份）
  - 包根 `_backup\`（自检移出物 + 历史 exe）
  - `data\logs\*`
- **不要把便携整包塞进 git**（561 MB；`runtime\node\node.exe` 单个 83 MB）⇒ 走 **Release 附件**
- `*.bak` 不要留在包里（`_tools`、插件目录下容易残留）

---

## 5. 换路径 / 换机后的首次启动

**会重写整份镜像**（proxy 里存的是绝对 `file://` 目标，路径变了就失效 ⇒ dsh 全量重建）——
这是**正常现象**，不是报错。壳的后端启动超时已放宽到 **300 s** 兜住慢盘。

---

## 6. 数据层健康判据

```powershell
<包根>\runtime\node\node.exe <包根>\_tools\selfcheck.mjs --root <包根>
```

期望看到：

```json
{"ok":true, "materializedFound":0, "materializedMoved":0, "danglingFound":0,
 "unrepairable":0, "linksTotal":0, "managedProxyFound":411, "selfNested":0}
```

- `ok:true` + `unrepairable:0` ⇒ 放行启动
- **别只看 `ok`**：`ok:true` 也可能是空目录/缺目录造成的假阴性 ⇒ 同时比 `managedProxyFound`（健康基线 **≈411**）

---

## 7. 编辑注意：Windows PowerShell 的编码坑（踩过）

本项目脚本含中文，而 **Windows PowerShell 5.1 读取「无 BOM」的 `.ps1` 时按 GBK 解码** ⇒
中文变乱码、引号配对被打乱 ⇒ 报一堆**假语法错误**（实测一次报出 15 处
「字符串缺少终止符 / 表达式或语句中包含意外的标记」）。

**⇒ 含中文的 `.ps1` 必须存为 UTF-8 with BOM。**

- VS Code：把该目录的 `"files.encoding"` 设为 `"utf8bom"`（或对 `.ps1` 单独设置）
- 命令行快速修复：

  ```powershell
  $f = '.\scripts\push-to-github.ps1'
  $t = Get-Content $f -Raw -Encoding UTF8
  [System.IO.File]::WriteAllText($f, $t, (New-Object System.Text.UTF8Encoding($true)))
  ```

- 自检（返回 0 = 语法正常）：

  ```powershell
  $e = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$e)
  $e.Count
  ```

> 注意：部分编辑器/工具保存时会**去掉 BOM** ⇒ 每次改完 `.ps1` 都建议跑一下上面的自检。
