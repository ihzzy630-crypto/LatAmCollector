$ErrorActionPreference = "Stop"

# Construct the Chinese folder name from Unicode code points so this source file
# remains plain ASCII and works in Windows PowerShell 5.1.
$WorkFolder = "gpt" + [char]0x4E13 + [char]0x7528 + [char]0x6587 + [char]0x4EF6
$InstallRoot = Join-Path ("D:\" + $WorkFolder) "LatAmCollector"
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
    Write-Host "LatAmCollector Windows environment installer" -ForegroundColor Green
    Write-Host ("Install directory: " + $InstallRoot)

    if (-not (Test-Python312)) {
        Write-Step "Python 3.12 was not found. Installing it with winget"
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
            throw "winget is unavailable. Install App Installer from Microsoft Store, then run this script again."
        }
        & winget install --id Python.Python.3.12 -e --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) {
            throw "Python 3.12 installation failed. winget exit code: $LASTEXITCODE"
        }
        Start-Sleep -Seconds 3
    }

    if (-not (Test-Python312)) {
        throw "Python 3.12 is installed but this PowerShell session cannot see it. Reopen PowerShell and run the script again."
    }

    Write-Step "Downloading the application source from GitHub"
    New-Item -ItemType Directory -Force -Path $TempRoot, $ExtractPath | Out-Null
    Invoke-WebRequest -Uri $RepoZip -OutFile $ZipPath -UseBasicParsing
    Expand-Archive -Path $ZipPath -DestinationPath $ExtractPath -Force
    $SourceRoot = Join-Path $ExtractPath "LatAmCollector-main"
    if (-not (Test-Path (Join-Path $SourceRoot "launcher.py"))) {
        throw "The downloaded package is incomplete: launcher.py was not found."
    }

    Write-Step "Copying files and preserving any existing data folder"
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
    Get-ChildItem -Path $SourceRoot -Force | ForEach-Object {
        if ($_.Name -notin @("data", ".venv", ".buildvenv")) {
            Copy-Item -Path $_.FullName -Destination $InstallRoot -Recurse -Force
        }
    }

    Write-Step "Creating an isolated Python environment"
    $VenvPython = Join-Path $InstallRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path $VenvPython)) {
        & py -3.12 -m venv (Join-Path $InstallRoot ".venv")
        if ($LASTEXITCODE -ne 0) {
            throw "The Python virtual environment could not be created."
        }
    }

    Write-Step "Installing required packages. This may take several minutes"
    & $VenvPython -m pip install --upgrade pip --timeout 120
    if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed." }
    & $VenvPython -m pip install -r (Join-Path $InstallRoot "requirements.txt") --timeout 120
    if ($LASTEXITCODE -ne 0) { throw "Package installation failed." }

    Write-Step "Checking core modules"
    & $VenvPython -c "import fastapi, uvicorn, openpyxl; print('Core modules OK')"
    if ($LASTEXITCODE -ne 0) { throw "Core module check failed." }

    Write-Step "Creating a desktop shortcut"
    $Desktop = [Environment]::GetFolderPath("Desktop")
    $ShortcutPath = Join-Path $Desktop "LatAmCollector.lnk"
    $Shell = New-Object -ComObject WScript.Shell
    $Shortcut = $Shell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = Join-Path $InstallRoot "start_platform.bat"
    $Shortcut.WorkingDirectory = $InstallRoot
    $Shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,220"
    $Shortcut.Description = "Start the LatAmCollector local platform"
    $Shortcut.Save()

    Write-Step "Installation completed"
    Write-Host "A LatAmCollector shortcut was created on the desktop." -ForegroundColor Green
    Write-Host "Platform URL: http://127.0.0.1:8765"
    Write-Host ("Data directory: " + (Join-Path $InstallRoot "data"))
    Write-Host "Starting the platform now..."
    Start-Process -FilePath (Join-Path $InstallRoot "start_platform.bat") -WorkingDirectory $InstallRoot
}
catch {
    Write-Host ""
    Write-Host ("Installation failed: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host "Keep this window open and send a screenshot of the error."
    Read-Host "Press Enter to close"
    exit 1
}
finally {
    if (Test-Path $TempRoot) {
        Remove-Item -Path $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

