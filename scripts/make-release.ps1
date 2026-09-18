# make-release.ps1 —— 打一个「干净的发行 zip」，并（可选）直接创建 GitHub Release
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\make-release.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\make-release.ps1 -CreateRelease
#   powershell -ExecutionPolicy Bypass -File .\scripts\make-release.ps1 -PackageRoot "D:\AI\dsh-desktop-lite" -Version v0.2.0
#
# 它做四件事：
#   1. 脱敏：删掉本机会话数据（会被下次启动重建，属正常）
#   2. 打 zip：排除诊断脚本 / 备份 / 日志 / *.bak，得到可直接分发的一包
#   3. 核对：确认 zip 里没有凭据、没有 _diag、没有 .bak
#   4. -CreateRelease：优先用 gh 创建 Release 并上传 zip；没有 gh 就打印网页/API 步骤

[CmdletBinding()]
param(
    [string]$PackageRoot = '',
    [string]$Version = 'v0.2.0',
    [string]$OutDir = '',
    [string]$Repo = 'Ringlingo/dsh-desktop-lite',
    [switch]$CreateRelease,
    [switch]$KeepUserData
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)

function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Ok($m) { Write-Host "    OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    !   $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "`n[中止] $m" -ForegroundColor Red; exit 1 }

if (-not $PackageRoot) { $PackageRoot = Join-Path (Split-Path -Parent $RepoRoot) 'dsh-desktop-lite' }
if (-not (Test-Path (Join-Path $PackageRoot 'dsh-desktop-lite.exe'))) { Die "找不到便携包：$PackageRoot（用 -PackageRoot 指定）" }
if (-not $OutDir) { $OutDir = Join-Path (Split-Path -Parent $RepoRoot) '_release' }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$ZipPath = Join-Path $OutDir ("dsh-desktop-lite-$Version.zip")

$PkgName = Split-Path $PackageRoot -Leaf
$PkgParent = Split-Path -Parent $PackageRoot

Write-Host "便携包: $PackageRoot"
Write-Host "输出:   $ZipPath"

# ── 1. 脱敏 ────────────────────────────────────────────────────────────────
Step 1 '脱敏（删本机会话数据）'
$targets = @(
    'data\.credentials.yaml',
    'data\.anonymous-user-id',
    'data\logs'
)
if ($KeepUserData) {
    Warn '-KeepUserData：跳过（注意：包里会带上本机会话密钥与设备 ID）'
} else {
    foreach ($t in $targets) {
        $p = Join-Path $PackageRoot $t
        if (Test-Path $p) {
            Get-ChildItem $p -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item $p -Force -Recurse -ErrorAction SilentlyContinue
            Ok "已删 $t"
        }
    }
    foreach ($d in @('data\logs', 'data\sessions', 'data\storages')) {
        $p = Join-Path $PackageRoot $d
        if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null; Ok "重建空目录 $d" }
    }
    Warn '这些会在下次启动时由 dsh 重新生成 —— 所以「脱敏」必须放在打包前最后一步'
}

# ── 2. 打 zip ──────────────────────────────────────────────────────────────
Step 2 "打 zip：$ZipPath"
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
$excludes = @(
    "--exclude=$PkgName/data/logs",
    "--exclude=$PkgName/data/downloads/_diag",
    "--exclude=$PkgName/data/backups",
    "--exclude=$PkgName/_backup",
    "--exclude=$PkgName/.credentials.yaml"
)
$tarArgs = @('-a', '-c', '-f', $ZipPath, '-C', $PkgParent) + $excludes + @($PkgName)
& tar.exe @tarArgs
if ($LASTEXITCODE -ne 0) { Die "tar 失败（exit $LASTEXITCODE）" }
$zip = Get-Item $ZipPath
Ok ('zip ' + [math]::Round($zip.Length / 1MB, 1) + ' MB')

# ── 3. 核对 zip 内容 ──────────────────────────────────────────────────────
Step 3 '核对 zip 内容（安全项）'
$entries = & tar.exe -tf $ZipPath
$bad = @()
foreach ($pat in @('credentials.yaml', '.anonymous-user-id', '/_diag/', '/_backup/', 'data/backups/', '.bak')) {
    $hit = @($entries | Where-Object { $_ -like ('*' + $pat + '*') })
    if ($hit.Count -gt 0) { $bad += "$pat × $($hit.Count)"; }
}
if ($bad.Count -gt 0) {
    Warn ('发现可疑条目：' + ($bad -join '、'))
    Warn '请检查上面这些是否确实要随包分发'
} else {
    Ok '未发现凭据 / _diag / _backup / data-backups / *.bak'
}
Ok ('条目总数 ' + @($entries).Count)

# ── 4. 创建 Release（可选）───────────────────────────────────────────────
if (-not $CreateRelease) {
    Step 4 '创建 Release：跳过（加 -CreateRelease 启用）'
    Write-Host "`n下一步（任选其一）：" -ForegroundColor White
    Write-Host "  A. 网页：https://github.com/$Repo/releases/new?tag=$Version → 上传 $ZipPath" -ForegroundColor Gray
    Write-Host "  B. 命令行（需装 gh）：gh release create $Version `"$ZipPath`" --repo $Repo --title `"$Version`" --generate-notes" -ForegroundColor Gray
    exit 0
}

Step 4 '创建 GitHub Release'
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Warn '未安装 gh，无法自动创建。两条路：'
    Write-Host "  A. 装 gh：winget install GitHub.cli  → 再跑一次本脚本加 -CreateRelease" -ForegroundColor Gray
    Write-Host "  B. 网页：https://github.com/$Repo/releases/new?tag=$Version → 上传 $ZipPath" -ForegroundColor Gray
    exit 0
}
$notes = @(
    "## $Version",
    '',
    '- 数据层改为 dsh 原生「代理目录」镜像：无 junction ⇒ ZIP 往返无损、换机不需建链接权限',
    '- 启动自检认代理目录；自检脚本编译期内嵌，写失败时 fail-open',
    '- 后端 PATH 注入 4 段、--no-open；就绪行兼容并保留 token 参数',
    '- 加载页补回状态行「正在启动，请稍候」',
    '- 设置页「运行时」独立图标（不再与「通用」重复）',
    '- 附：tools/check-dsh-patches.mjs（换包体检）、docs/APPLY-ON-NEW-PACKAGE.md（恢复清单）'
) -join "`n"
$notesFile = Join-Path $OutDir "_notes-$Version.md"
[System.IO.File]::WriteAllText($notesFile, $notes, (New-Object System.Text.UTF8Encoding($false)))

gh release create $Version $ZipPath --repo $Repo --title $Version --notes-file $notesFile
if ($LASTEXITCODE -ne 0) { Die 'gh release create 失败（通常是未登录：gh auth login）' }
Ok "Release 已创建：https://github.com/$Repo/releases/tag/$Version"
