$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$InstallRoot = "D:\gpt专用文件\LatAmCollector"
$RepoZip = "https://github.com/ihzzy630-crypto/LatAmCollector/archive/refs/heads/main.zip"
$TempRoot = Join-Path $env:TEMP ("LatAmCollector-Setup-" + $PID)
$ZipPath = Join-Path $TempRoot "LatAmCollector-main.zip"
$ExtractPath = Join-Path $TempRoot "source"

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host ("==> " + $Text) -ForegroundColor Cyan
}

function Test-Python312 {
    try {
        $version = & py -3.12 -c "import sys; print('.'.join(map(str, sys.version_info[:3])))" 2>$null
        return ($LASTEXITCODE -eq 0 -and $version -like "3.12.*")
    }
    catch {
        return $false
    }
}

try {
    Write-Host "LatAmCollector Windows 环境安装程序" -ForegroundColor Green
    Write-Host "安装目录：$InstallRoot"

    if (-not (Test-Python312)) {
        Write-Step "没有检测到 Python 3.12，准备通过 winget 安装"
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
            throw "未检测到 winget。请先从 Microsoft Store 安装“应用安装程序”，然后重新运行。"
        }
        & winget install --id Python.Python.3.12 -e --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) {
            throw "Python 3.12 安装失败，winget 返回代码 $LASTEXITCODE。"
        }
        Start-Sleep -Seconds 3
    }

    if (-not (Test-Python312)) {
        throw "Python 3.12 已安装但当前 PowerShell 尚未识别。请关闭 PowerShell，重新打开后再运行本脚本。"
    }

    Write-Step "创建临时目录并下载 GitHub 源码"
    New-Item -ItemType Directory -Force -Path $TempRoot, $ExtractPath | Out-Null
    Invoke-WebRequest -Uri $RepoZip -OutFile $ZipPath -UseBasicParsing
    Expand-Archive -Path $ZipPath -DestinationPath $ExtractPath -Force
    $SourceRoot = Join-Path $ExtractPath "LatAmCollector-main"
    if (-not (Test-Path (Join-Path $SourceRoot "launcher.py"))) {
        throw "下载包结构不正确，没有找到 launcher.py。"
    }

    Write-Step "复制程序文件（保留已有 data 数据库）"
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
    Get-ChildItem -Path $SourceRoot -Force | ForEach-Object {
        if ($_.Name -notin @("data", ".venv", ".buildvenv")) {
            Copy-Item -Path $_.FullName -Destination $InstallRoot -Recurse -Force
        }
    }

    Write-Step "创建独立 Python 虚拟环境"
    $VenvPython = Join-Path $InstallRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path $VenvPython)) {
        & py -3.12 -m venv (Join-Path $InstallRoot ".venv")
        if ($LASTEXITCODE -ne 0) {
            throw "虚拟环境创建失败。"
        }
    }

    Write-Step "安装平台依赖，这一步可能需要几分钟"
    & $VenvPython -m pip install --upgrade pip --timeout 120
    if ($LASTEXITCODE -ne 0) { throw "pip 更新失败。" }
    & $VenvPython -m pip install -r (Join-Path $InstallRoot "requirements.txt") --timeout 120
    if ($LASTEXITCODE -ne 0) { throw "依赖安装失败。" }

    Write-Step "检查核心模块"
    & $VenvPython -c "import fastapi, uvicorn, openpyxl; print('核心模块检查通过')"
    if ($LASTEXITCODE -ne 0) { throw "核心模块检查失败。" }

    Write-Step "创建桌面快捷方式"
    $Desktop = [Environment]::GetFolderPath("Desktop")
    $ShortcutPath = Join-Path $Desktop "LatAmCollector.lnk"
    $Shell = New-Object -ComObject WScript.Shell
    $Shortcut = $Shell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = Join-Path $InstallRoot "start_platform.bat"
    $Shortcut.WorkingDirectory = $InstallRoot
    $Shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,220"
    $Shortcut.Description = "启动 LatAmCollector 本地采集平台"
    $Shortcut.Save()

    Write-Step "安装完成"
    Write-Host "桌面已生成 LatAmCollector 快捷方式。" -ForegroundColor Green
    Write-Host "平台地址：http://127.0.0.1:8765"
    Write-Host "数据目录：$InstallRoot\data"
    Write-Host "正在启动平台……"
    Start-Process -FilePath (Join-Path $InstallRoot "start_platform.bat") -WorkingDirectory $InstallRoot
}
catch {
    Write-Host ""
    Write-Host ("安装失败：" + $_.Exception.Message) -ForegroundColor Red
    Write-Host "请保留这个窗口并截图发给我。"
    Read-Host "按回车键关闭"
    exit 1
}
finally {
    if (Test-Path $TempRoot) {
        Remove-Item -Path $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

