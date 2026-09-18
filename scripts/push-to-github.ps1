# push-to-github.ps1 —— 把本项目推送到 GitHub（一键）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\push-to-github.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\push-to-github.ps1 -Fresh     # 不要远端历史，强制覆盖
#
# 默认行为（推荐）：**保留远端已有提交**，把本地改动作为新提交叠加上去。
#   git init → remote add → fetch → reset origin/<branch>（只动索引，不动工作区）
#   → 体检 → 核对差异 → commit → push
#
# -Fresh：远端历史不要了，本地内容作为全新起点强推（会覆盖远端所有提交）。

[CmdletBinding()]
param(
    [string]$Remote = 'https://github.com/Ringlingo/dsh-desktop-lite.git',
    [string]$Branch = 'main',
    [string]$Message = '',
    [switch]$Fresh
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $RepoRoot

function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Ok($m) { Write-Host "    OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    !   $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "`n[中止] $m" -ForegroundColor Red; exit 1 }

if (-not $Message) {
    # 用数组 join 构造提交信息（避免 here-string 对行首缩进的严格要求）
    $Message = @(
        'feat(shell): 修复数据层可移植性，换路径/解压后可直接启动',
        '',
        '- 启动自检识别 dsh 托管的「代理目录」，不再误判为物化并移出',
        '- 自检脚本编译期内嵌；写失败时 fail-open，不再阻断启动',
        '- 后端 PATH 注入 4 段 + --no-open；就绪行兼容并保留 token 参数',
        '- 加载页补回 splash-status；余额去掉人民币图标；设置页「运行时」换独立图标',
        '- 新增换包体检脚本与恢复清单（tools/ docs/）'
    ) -join "`n"
}

Write-Host "仓库根目录: $RepoRoot" -ForegroundColor White
Write-Host "远端:      $Remote"
Write-Host "分支:      $Branch"
Write-Host ("模式:      " + $(if ($Fresh) { '全新历史（-Fresh，会强推覆盖远端）' } else { '保留远端历史（叠加提交）' }))

# ── 0. 前置检查 ────────────────────────────────────────────────────────────
Step 0 '前置检查'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die '找不到 git，请先安装 Git for Windows。' }
Ok ('git ' + (git --version))
if (-not (Test-Path (Join-Path $RepoRoot '.gitignore'))) {
    Die '仓库根目录缺少 .gitignore —— 绝不能在没有它的情况下提交（会带上 src-tauri/target/ 等 1.7 GB 产物）。'
}
$gi = Get-Content (Join-Path $RepoRoot '.gitignore') -Raw
foreach ($need in @('src-tauri/target/', 'runtime/', 'data/')) {
    if ($gi -notmatch [regex]::Escape($need)) { Warn ".gitignore 里没看到「$need」，请确认" }
}
Ok '.gitignore 就位'

# ── 1. 数据层体检（包在附近才跑）─────────────────────────────────────────
Step 1 '换包体检（tools/check-dsh-patches.mjs）'
$pkg = Join-Path (Split-Path -Parent $RepoRoot) 'dsh-desktop-lite'
$nodeExe = Join-Path $pkg 'runtime\node\node.exe'
$checker = Join-Path $RepoRoot 'tools\check-dsh-patches.mjs'
if ((Test-Path $nodeExe) -and (Test-Path $checker)) {
    & $nodeExe $checker --root $pkg
    if ($LASTEXITCODE -ne 0) {
        Warn '体检有未通过项（见上方 FAIL 与处置指引）。不影响推送源码，但说明便携包里的补丁有缺失。'
        $ans = Read-Host '    仍要继续推送吗？(y/N)'
        if ($ans -notmatch '^[yY]') { Die '按你的选择中止。' }
    } else { Ok '全部补丁在位' }
} else {
    Warn '未找到便携包或体检脚本，跳过（只推源码不受影响）'
}

# ── 2. 初始化 / 接远端 ────────────────────────────────────────────────────
Step 2 '初始化仓库并连接远端'
if (-not (Test-Path (Join-Path $RepoRoot '.git'))) {
    git init | Out-Null
    git branch -M $Branch
    Ok 'git init 完成'
} else {
    Ok '.git 已存在，复用'
}

$remotes = @(git remote 2>$null)
if ($remotes -contains 'origin') {
    git remote set-url origin $Remote
    Ok 'origin 已更新'
} else {
    git remote add origin $Remote
    Ok 'origin 已添加'
}

if (-not $Fresh) {
    Step '2b' "拉取远端历史（分支 $Branch）"
    git fetch origin $Branch
    if ($LASTEXITCODE -ne 0) { Die 'fetch 失败（通常是认证或网络）。可改用 -Fresh 跳过这一步。' }
    git reset "origin/$Branch" | Out-Null
    Ok "索引已对齐 origin/$Branch —— 远端历史保留，工作区文件未被改动"
}

# ── 3. 核对差异 ───────────────────────────────────────────────────────────
Step 3 '将要提交的差异'
git add -A
$staged = @(git status --short)
if ($staged.Count -eq 0) { Warn '没有任何改动 —— 远端已是最新？'; exit 0 }
git diff --cached --stat | Select-Object -Last 1 | ForEach-Object { Write-Host $_ }
Write-Host ("    共 " + $staged.Count + " 项变更") -ForegroundColor White

$bigFiles = @()
foreach ($line in (git diff --cached --numstat)) {
    $parts = $line -split "`t"
    if ($parts.Count -ge 3 -and $parts[0] -match '^\d+$' -and [int]$parts[0] -gt 5MB) { $bigFiles += $parts[2] }
}
if ($bigFiles.Count -gt 0) { Warn ('有单文件超过 5 MB：' + ($bigFiles -join ', ') + ' —— 确认不是产物/二进制') }

# ── 4. 提交 ───────────────────────────────────────────────────────────────
Step 4 '提交'
$who = git config user.name
$mail = git config user.email
if (-not $who) { Warn 'git 未配置 user.name。请先执行：git config --global user.name "你的名字"' }
if (-not $mail) { Warn 'git 未配置 user.email。请先执行：git config --global user.email "你的邮箱"' }
if (-not $who -or -not $mail) { Die '请先配置 git 身份后重跑。' }

git commit -m $Message
if ($LASTEXITCODE -ne 0) { Die 'commit 失败。' }
git log -1 --oneline | ForEach-Object { Ok $_ }

# ── 5. 推送 ───────────────────────────────────────────────────────────────
Step 5 '推送'
Write-Host '    首次推送会弹出 GitHub 登录窗口（Git Credential Manager）。' -ForegroundColor Yellow
if ($Fresh) {
    Warn '模式 = -Fresh：将强制覆盖远端分支历史'
    $ans = Read-Host '    确认强推？(y/N)'
    if ($ans -notmatch '^[yY]') { Die '按你的选择中止（未推送）。' }
    git push -f -u origin $Branch
} else {
    git push -u origin $Branch
}
if ($LASTEXITCODE -ne 0) { Die 'push 失败（多为认证问题）。在弹出窗口重新登录后重跑本脚本即可。' }

Ok '推送完成'
Write-Host "`n仓库地址: https://github.com/Ringlingo/dsh-desktop-lite" -ForegroundColor Green
Write-Host "分支:     $Branch`n" -ForegroundColor Green
