# update-dsh-progress.ps1 —— 带进度条/百分比的 dsh 升级启动器
#
# 作用：调用随包的官方升级脚本 data/downloads/update-dsh.mjs，把它的阶段输出
#      实时映射成「进度条 + 百分比 + 当前阶段」，完成后给出结论与下一步。
#
# 为什么需要它：官方脚本只打印文字阶段，没有进度感；而**升级必须在本应用完全退出时进行**
#       （脚本会检查「应用正在运行」并拒绝，以免文件被占用导致 runtime/dsh 损坏）。
#
# 用法（先完全退出应用，含托盘）：
#   powershell -ExecutionPolicy Bypass -File .\scripts\update-dsh-progress.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\update-dsh-progress.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File .\scripts\update-dsh-progress.ps1 -Version 0.1.6-alpha.2
#   powershell -ExecutionPolicy Bypass -File .\scripts\update-dsh-progress.ps1 -Root "D:\AI\dsh-desktop-lite"

[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$Version = '',
    [switch]$DryRun,
    [switch]$NoPause
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

# ── 定位应用根目录：优先 -Root，其次脚本所在目录的上一级（scripts/ → 根）────────
$ScriptDir = Split-Path -Parent $PSCommandPath
if (-not $Root) {
    $guess = Split-Path -Parent $ScriptDir
    if (Test-Path (Join-Path $guess 'runtime\node\node.exe')) { $Root = $guess }
    else {
        # 允许从仓库 scripts/ 运行：找同级的便携包
        $sibling = Join-Path (Split-Path -Parent $ScriptDir) 'dsh-desktop-lite'
        if (Test-Path (Join-Path $sibling 'runtime\node\node.exe')) { $Root = $sibling }
    }
}
if (-not $Root -or -not (Test-Path (Join-Path $Root 'runtime\node\node.exe'))) {
    Write-Host '找不到便携包（需要含 runtime\node\node.exe）。请用 -Root 指定。' -ForegroundColor Red
    if (-not $NoPause) { Read-Host '按回车退出' }
    exit 2
}

$Node = Join-Path $Root 'runtime\node\node.exe'
$Script = Join-Path $Root 'data\downloads\update-dsh.mjs'
if (-not (Test-Path $Script)) { $Script = Join-Path $Root 'scripts\update-dsh.mjs' }
if (-not (Test-Path $Script)) {
    Write-Host "找不到升级脚本：$Script" -ForegroundColor Red
    if (-not $NoPause) { Read-Host '按回车退出' }
    exit 2
}

# ── 阶段表：关键词 → 百分比 + 阶段名（对齐 update-dsh.mjs 的实际流程）──────────
$Stages = @(
    @{ k = '运行时升级';            p = 4;  n = '准备' },
    @{ k = '应用根目录';            p = 6;  n = '定位目录' },
    @{ k = '内置 node';             p = 8;  n = '检查运行时' },
    @{ k = '当前 dsh 版本';         p = 10; n = '读取当前版本' },
    @{ k = '应用未在运行';          p = 12; n = '运行中检查' },
    @{ k = '应用正在运行';          p = 12; n = '运行中检查（未通过）' },
    @{ k = '目标 dsh 版本';         p = 16; n = '解析目标版本' },
    @{ k = '解析来源';              p = 18; n = '解析目标版本' },
    @{ k = 'npm';                   p = 45; n = '下载并暂存（最慢的一步）' },
    @{ k = '暂存';                  p = 45; n = '下载并暂存' },
    @{ k = '预检';                  p = 68; n = '启动兼容性预检' },
    @{ k = '备份';                  p = 78; n = '备份现有运行时' },
    @{ k = '替换';                  p = 88; n = '替换 runtime/dsh' },
    @{ k = '迁移';                  p = 92; n = '数据层迁移' },
    @{ k = '真机';                  p = 95; n = '真机启动预检' },
    @{ k = '完成';                  p = 100; n = '收尾' },
    @{ k = '收尾';                  p = 100; n = '收尾' }
)

$script:Pct = 0
$script:Stage = '启动中'
$script:Spin = 0

function Draw-Bar {
    param([int]$Pct, [string]$Stage, [switch]$Done, [switch]$Failed)
    $width = 34
    $filled = [Math]::Min($width, [Math]::Max(0, [int][Math]::Round($width * $Pct / 100.0)))
    $bar = ('#' * $filled) + ('.' * ($width - $filled))
    $color = if ($Failed) { 'Red' } elseif ($Done) { 'Green' } else { 'Cyan' }
    Write-Host ("`r  [{0}] {1,3}%  {2,-28}" -f $bar, $Pct, $Stage) -NoNewline -ForegroundColor $color
}

Write-Host ''
Write-Host '  dsh 运行时升级' -ForegroundColor White
Write-Host ("  应用根目录: {0}" -f $Root) -ForegroundColor DarkGray
Write-Host ("  升级脚本  : {0}" -f $Script) -ForegroundColor DarkGray
if ($DryRun) { Write-Host '  模式      : --dry-run（只探测，不改动）' -ForegroundColor Yellow }
Write-Host ''

$nodeArgs = @($Script, '--root', $Root)
if ($Version) { $nodeArgs += @('--version', $Version) }
if ($DryRun) { $nodeArgs += '--dry-run' }

$lines = New-Object System.Collections.Generic.List[string]
& $Node @nodeArgs 2>&1 | ForEach-Object {
    $line = "$_"
    $lines.Add($line) | Out-Null
    foreach ($s in $Stages) {
        if ($line -like ('*' + $s.k + '*')) {
            if ($s.p -gt $script:Pct) { $script:Pct = $s.p }
            $script:Stage = $s.n
            break
        }
    }
    Draw-Bar -Pct $script:Pct -Stage $script:Stage
}
$rc = $LASTEXITCODE

$ok = ($rc -eq 0)
Draw-Bar -Pct ($(if ($ok) { 100 } else { $script:Pct })) -Stage ($(if ($ok) { '完成' } else { '未完成' })) -Done:$ok -Failed:(-not $ok)
Write-Host ''
Write-Host ''

if ($ok) {
    Write-Host '  ✓ 升级成功' -ForegroundColor Green
    if ($DryRun) { Write-Host '    （dry-run：未改动任何文件）' -ForegroundColor DarkGray }
    else { Write-Host '    请重新双击 dsh-desktop-lite.exe 启动应用（会自动拉起新版本 dsh）' -ForegroundColor Green }
} else {
    Write-Host '  ✗ 升级未完成（退出码 ' -NoNewline -ForegroundColor Red
    Write-Host ($rc.ToString() + '）') -ForegroundColor Red
    Write-Host '    常见原因：' -ForegroundColor Yellow
    $running = @($lines | Where-Object { $_ -like '*应用正在运行*' }).Count -gt 0
    if ($running) {
        Write-Host '      · 应用还在运行 —— 请从托盘菜单彻底退出（右键托盘图标 → 退出），再跑一次本脚本' -ForegroundColor Yellow
    }
    Write-Host '      · 网络/代理不通（脚本需要访问 GitHub tag 与 npm 源）' -ForegroundColor Yellow
    Write-Host '      · 磁盘空间不足' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '    完整输出（最后 12 行）：' -ForegroundColor DarkGray
    $lines | Select-Object -Last 12 | ForEach-Object { Write-Host ('      ' + $_) -ForegroundColor DarkGray }
}

if (-not $NoPause) { Write-Host ''; Read-Host '按回车退出' }
exit $rc
