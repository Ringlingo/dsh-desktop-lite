# dsh-runtime-inspector

给 dsh 设置面板加一个**「运行时」**页面，只读展示本便携包自带的三个运行时
（Node.js / Python / Git）的实际状态：版本、可执行文件、占用、来源、是否已进 PATH。

## 结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | 声明 bundle（`dsh.bundle.patch`）与客户端半边（`exports["./client"]` + `dsh.client.platform=web`） |
| `cordis.patch.yml` | 把本插件插入 profile 的加载树 |
| `lib/index.js` | **宿主半边**：注册只读路由 `GET /runtime-inspector/api`，读取 `runtime/runtimes.json` 并实测各运行时的 `--version` |
| `lib/client.js` | **客户端半边**：向 `settings.section` 注册 `id=runtime / order=30` 的页面 |

## 数据流

```
runtime/runtimes.json ──┐
                        ├─→ lib/index.js（宿主，dsh node 进程）──→ GET /runtime-inspector/api
各运行时 --version 实测 ─┘                                            │
                                                                      ↓
                                          lib/client.js（浏览器同源 fetch）→ 设置 › 运行时
```

- 根目录由 `lib/index.js` 的物理位置反推（`lib → 插件目录 → plugins → data → 根目录`），
  不写死任何绝对路径，整包搬移或换盘后依然可用。
- 页面与 dsh 后端同源（壳会把 WebView 导航到 `http://127.0.0.1:<dsh端口>/`），所以用相对路径 `fetch`。

## 注册方式（与 `tabbit-browser` 同范式）

1. `data/profiles/web/package.json`
   - `dsh.profile.bundles` 追加 `"dsh-runtime-inspector"`
   - `dependencies` 追加 `"dsh-runtime-inspector": "link:../../plugins/dsh-runtime-inspector"`
2. 建 junction：`data/profiles/web/node_modules/dsh-runtime-inspector` → `data/plugins/dsh-runtime-inspector`

## 为什么顺带汇报 `process.env.PATH`

壳（`dsh-desktop-lite.exe`）是它自己拉起 dsh 后端的：启动器只能把注入后的 PATH 交给壳，
**无法直接观察到壳→后端那一步**。所以路由把后端进程实际看到的 PATH 与「运行时目录是否在里面」
一并吐出来，这样「PATH 注入是否生效」就能被一次性验证，不必猜。

## 卸载 / 回滚

1. 从 `data/profiles/web/package.json` 的 `bundles` 与 `dependencies` 里删掉两项；
2. 删掉 junction `data/profiles/web/node_modules/dsh-runtime-inspector`；
3. 重启应用（或从壳控制台「重启后端」）。

`data/plugins/dsh-runtime-inspector/` 目录本身留着不影响启动。
