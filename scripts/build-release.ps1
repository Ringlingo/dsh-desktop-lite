# build-release.ps1 - 构建 dsh-desktop-lite 免安装包
# 用法: .\scripts\build-release.ps1

param(
    [string]$Version = "0.0.1",
    [string]$SourceDir = (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$ReleaseDir = "$Root\release\dsh-desktop-lite"

Write-Host "=== dsh-desktop-lite v$Version 构建 ===" -ForegroundColor Cyan
Write-Host "源目录: $SourceDir"
Write-Host "输出目录: $ReleaseDir"

# 1. 编译 exe
Write-Host "`n[1/6] 编译 exe..." -ForegroundColor Yellow
Push-Location "$SourceDir\src-tauri"
# 确保 cargo 可用：不在 PATH 时补上用户级安装位置（不写死任何机器路径）
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
    if (Test-Path $cargoBin) { $env:Path = "$cargoBin;$env:Path" }
}
cargo build --release 2>&1 | Select-Object -Last 5
Pop-Location

# 2. 创建 release 目录
Write-Host "`n[2/6] 创建 release 目录..." -ForegroundColor Yellow
if (Test-Path $ReleaseDir) { Remove-Item $ReleaseDir -Recurse -Force }
New-Item -Path $ReleaseDir -ItemType Directory -Force | Out-Null
New-Item -Path "$ReleaseDir\ui" -ItemType Directory -Force | Out-Null
New-Item -Path "$ReleaseDir\runtime\node" -ItemType Directory -Force | Out-Null
New-Item -Path "$ReleaseDir\runtime\dsh" -ItemType Directory -Force | Out-Null
New-Item -Path "$ReleaseDir\data" -ItemType Directory -Force | Out-Null

# 3. 复制 exe
Write-Host "`n[3/6] 复制 exe..." -ForegroundColor Yellow
$ExeSrc = "$SourceDir\src-tauri\target\release\dsh-portable.exe"
if (-not (Test-Path $ExeSrc)) {
    Write-Host "exe 不存在，尝试 debug 版本..." -ForegroundColor Red
    $ExeSrc = "$SourceDir\src-tauri\target\debug\dsh-portable.exe"
}
Copy-Item $ExeSrc "$ReleaseDir\dsh-desktop-lite.exe"
Write-Host "  复制: dsh-desktop-lite.exe ($([math]::Round((Get-Item $ExeSrc).Length/1MB, 1)) MB)"

# 4. 复制 ui/index.html
Write-Host "`n[4/6] 复制 ui..." -ForegroundColor Yellow
Copy-Item "$SourceDir\ui\index.html" "$ReleaseDir\ui\index.html"
Write-Host "  复制: ui/index.html"

# 5. 复制 runtime
Write-Host "`n[5/6] 复制 runtime..." -ForegroundColor Yellow
Copy-Item "$SourceDir\runtime\node\node.exe" "$ReleaseDir\runtime\node\node.exe"
Write-Host "  复制: runtime/node/node.exe ($([math]::Round((Get-Item "$SourceDir\runtime\node\node.exe").Length/1MB, 1)) MB)"

Write-Host "  复制: runtime/dsh/ (node_modules)..." -NoNewline
Copy-Item "$SourceDir\runtime\dsh\*" "$ReleaseDir\runtime\dsh\" -Recurse -Force
$dshSize = (Get-ChildItem "$ReleaseDir\runtime\dsh" -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host " ($([math]::Round($dshSize/1MB, 1)) MB)"

# 6. 精简：删除不影响运行的文件（保留插件完整性）
Write-Host "`n[6/8] 精简 runtime..." -ForegroundColor Yellow
$NmDir = "$ReleaseDir\runtime\dsh\node_modules"
$removedSize = 0

# ARM64 二进制（x64 不需要）
@(
    "$NmDir\node-pty\prebuilds\win32-arm64",
    "$NmDir\@img\sharp-wasm32",
    "$NmDir\@koromix\koffi-win32-arm64"
) | ForEach-Object {
    if (Test-Path $_) {
        $s = (Get-ChildItem $_ -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        Remove-Item $_ -Recurse -Force
        $removedSize += $s
    }
}

# Source maps（.map 文件，运行时不需要）
$maps = Get-ChildItem $NmDir -Recurse -Include "*.map" -File -ErrorAction SilentlyContinue
$mapSize = ($maps | Measure-Object -Property Length -Sum).Sum
$maps | Remove-Item -Force
$removedSize += $mapSize

# 测试/示例/基准目录
@("test","tests","__tests__","spec","example","examples","benchmark","benchmarks","__mocks__","fixtures","__fixtures__") | ForEach-Object {
    $dirs = Get-ChildItem $NmDir -Recurse -Directory -Filter $_ -ErrorAction SilentlyContinue
    foreach ($d in $dirs) {
        # 只删 node_modules 内的，不删顶层
        if ($d.FullName -match "node_modules\\.+\\node_modules\\" -or $d.FullName -match "node_modules\\[^\\]+\\(test|tests|__tests__|spec|example|examples|benchmark|benchmarks|__mocks__|fixtures|__fixtures__)") {
            $s = (Get-ChildItem $d.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
            Remove-Item $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
            $removedSize += $s
        }
    }
}

# 文档文件（README/CHANGELOG/HISTORY 等，保留 LICENSE）
Get-ChildItem $NmDir -Recurse -Include "README*","CHANGELOG*","HISTORY*","CHANGES*","CONTRIBUTING*","AUTHORS*","HACKING*","SECURITY*","UPGRADING*","MIGRATION*",".npmignore",".gitignore",".editorconfig",".eslintrc*",".prettierrc*","tsconfig*.json","jest.config*","vitest.config*","webpack.config*","rollup.config*","vite.config*",".babelrc*","babel.config*","Makefile","Gruntfile*","Gulpfile*","*.coffee","*.litcoffee","*.tsbuildinfo" -File -ErrorAction SilentlyContinue | ForEach-Object {
    $removedSize += $_.Length
    Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
}

# TypeScript 源码（只删 node_modules 内的 .ts 文件，保留 .d.ts 类型声明）
Get-ChildItem $NmDir -Recurse -Include "*.ts" -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -eq ".ts" -and $_.FullName -notmatch "\.d\.ts$" -and $_.FullName -match "node_modules" } | ForEach-Object {
    $removedSize += $_.Length
    Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
}

Write-Host "  精简: $([math]::Round($removedSize/1MB, 1)) MB"

# 7. 创建空 data 结构
Write-Host "`n[7/8] 创建 data 目录结构..." -ForegroundColor Yellow
@("profiles", "sessions", "storages", "logs") | ForEach-Object {
    New-Item -Path "$ReleaseDir\data\$_" -ItemType Directory -Force | Out-Null
}

# 统计
$TotalSize = (Get-ChildItem $ReleaseDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
$FileCount = (Get-ChildItem $ReleaseDir -Recurse -File).Count

Write-Host "`n=== 构建完成 ===" -ForegroundColor Green
Write-Host "输出: $ReleaseDir"
Write-Host "大小: $([math]::Round($TotalSize/1MB, 1)) MB ($FileCount files)"

# 8. 打包 zip
$ZipPath = "$Root\release\dsh-desktop-lite-v$Version.zip"
Write-Host "`n[8/8] 打包: $ZipPath" -ForegroundColor Yellow
Compress-Archive -Path $ReleaseDir -DestinationPath $ZipPath -Force
$ZipSize = (Get-Item $ZipPath).Length
Write-Host "完成: $([math]::Round($ZipSize/1MB, 1)) MB" -ForegroundColor Green
