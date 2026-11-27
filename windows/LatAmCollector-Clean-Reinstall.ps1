& {
    $ErrorActionPreference = 'Stop'
    if ($env:OS -ne 'Windows_NT') { throw 'Run this script on the Windows PC that has LatAmCollector.' }

    $version = '0.8.0'
    $base = 'http://127.0.0.1:8765'
    $setupName = 'LatAmCollector-Setup-0.8.0-x64.exe'
    $setupHash = '4550d5ed4f856320c18274de47b1e189a98b94bf51e989714fd9befce902e374'
    $setupUrl = 'https://github.com/ihzzy630-crypto/LatAmCollector/releases/download/windows-v0.8.0/' + $setupName
    $productKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{14E201DE-F964-49EF-9FB8-C577FEC647F0}_is1'
    $legacyParent = 'D:\gpt' + [char]0x4E13 + [char]0x7528 + [char]0x6587 + [char]0x4EF6
    $legacy = [IO.Path]::Combine($legacyParent, 'LatAmCollector')
    $default = Join-Path $env:LOCALAPPDATA 'Programs\LatAmCollector'
    $downloads = Join-Path $env:USERPROFILE 'Downloads'

    function Read-Platform {
        try {
            $response = Invoke-WebRequest -Uri "$base/api/system" -UseBasicParsing -TimeoutSec 2
            [Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()) | ConvertFrom-Json
        }
        catch { $null }
    }

    function Get-InstallRecords {
        foreach ($key in @("HKCU:\$productKey", "HKLM:\$productKey")) {
            if (Test-Path -LiteralPath $key) {
                Get-ItemProperty -LiteralPath $key
            }
        }
    }

    function Full-Path([string]$path) {
        [IO.Path]::GetFullPath($path).TrimEnd([char]'\')
    }

    function Confirm-AppRoot([string]$path) {
        if ($path -notmatch '^[A-Za-z]:\\.+\\LatAmCollector\\?$') {
            throw "Unexpected LatAmCollector directory. Review it before cleaning: $path"
        }
        $folder = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        $data = Get-Item -LiteralPath (Join-Path $path 'data') -Force -ErrorAction SilentlyContinue
        foreach ($entry in @($folder, $data)) {
            if ($entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "This folder is redirected. Review it before moving files: $($entry.FullName)"
            }
        }
        Full-Path $path
    }

    function Test-AppFiles([string]$root) {
        if (!(Test-Path -LiteralPath $root -PathType Container)) { return $false }
        $catalog = Join-Path $root 'data\latam_collector.db'
        if (Test-Path -LiteralPath $catalog -PathType Leaf) { return $true }
        $manifest = Join-Path $root 'chrome_extension\manifest.json'
        if (!(Test-Path -LiteralPath $manifest -PathType Leaf)) { return $false }
        return (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).name -like 'LatAmCollector*'
    }

    function Find-Setup([string]$parent) {
        foreach ($folder in @($downloads, $legacyParent, $parent) | Sort-Object -Unique) {
            $candidate = [IO.Path]::Combine($folder, $setupName)
            if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and
                (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash -eq $setupHash) {
                return $candidate
            }
        }
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        $target = Join-Path $parent $setupName
        $part = Join-Path $parent ($setupName + '.' + [guid]::NewGuid().ToString('N') + '.part')
        Write-Host 'Downloading the verified Windows installer (about 185 MB)...'
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            & curl.exe --fail --location --retry 2 --output $part $setupUrl
            if ($LASTEXITCODE -ne 0) { throw 'The installer download failed.' }
        } else {
            Invoke-WebRequest -Uri $setupUrl -UseBasicParsing -OutFile $part
        }
        if ((Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash -ne $setupHash) {
            throw 'The downloaded installer did not pass SHA-256 verification.'
        }
        if (Test-Path -LiteralPath $target) {
            # Keep any different file the user already put at the standard filename.
            $target = Join-Path $parent ('Verified-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '-' + $setupName)
        }
        Move-Item -LiteralPath $part -Destination $target
        return $target
    }

    function Restore-Library([string]$snapshot, [string]$root) {
        if (!$snapshot -or !(Test-Path -LiteralPath (Join-Path $snapshot 'latam_collector.db') -PathType Leaf)) {
            return
        }
        $destination = Join-Path $root 'data'
        if (Test-Path -LiteralPath (Join-Path $destination 'latam_collector.db')) {
            throw "A database already exists at $destination. The original snapshot is at $snapshot."
        }
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        foreach ($name in @('latam_collector.db', 'latam_collector.db-wal')) {
            $source = Join-Path $snapshot $name
            if (Test-Path -LiteralPath $source -PathType Leaf) {
                Copy-Item -LiteralPath $source -Destination $destination
            }
        }
    }

    Write-Host 'Checking the existing LatAmCollector installation...'
    $location = (Get-Location).Path
    $running = Read-Platform
    $liveRoot = $null
    if ($running) {
        if (!$running.connectors.shopee -or
            $running.database -notmatch '\\data\\latam_collector\.db$' -or
            !(Test-Path -LiteralPath $running.database -PathType Leaf)) {
            throw 'Port 8765 returned an unexpected service.'
        }
        $liveRoot = Confirm-AppRoot (Split-Path -Parent (Split-Path -Parent $running.database))
    }
    $records = @(Get-InstallRecords)
    $registered = @($records | ForEach-Object {
        $dir = $_.InstallLocation
        if (!$dir) { $dir = $_.'Inno Setup: App Path' }
        if ($dir) { Confirm-AppRoot $dir }
    })
    $known = @(@($liveRoot) + $registered + @($legacy, $default) |
        Where-Object { $_ -and (Test-AppFiles $_) } |
        ForEach-Object { Confirm-AppRoot $_ })
    $target = $known | Where-Object {
        Test-Path -LiteralPath (Join-Path $_ 'data\latam_collector.db') -PathType Leaf
    } | Select-Object -First 1
    if (!$target) { $target = $known | Select-Object -First 1 }
    if (!$target) {
        $target = if (Test-Path -LiteralPath $legacyParent -PathType Container) { $legacy } else { $default }
        if (Test-Path -LiteralPath $target) { throw "The destination is occupied by an unrecognized folder: $target" }
    }
    $roots = @($known | Sort-Object -Unique)
    $uninstallers = @($records | ForEach-Object {
        if ($_.UninstallString -match '^"?(?<file>.+?\\unins\d+\.exe)"?(?:\s|$)') {
            $uninstaller = Full-Path $Matches.file
            if ($registered -contains (Split-Path -Parent $uninstaller) -and
                (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
                $uninstaller
            }
        }
    } | Sort-Object -Unique)

    $stop = @()
    $listener = @(Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::') })
    if ($running -or $listener.Count) {
        if (!$running -or $listener.Count -ne 1) { throw 'Cannot identify the service using port 8765.' }
        $pidFile = Join-Path $liveRoot 'data\server.pid'
        $serverId = [int](Get-Content -LiteralPath $pidFile -Raw)
        if ($listener[0].OwningProcess -ne $serverId) { throw 'The local process and PID record differ.' }
        $server = Get-Process -Id $serverId
        $exe = Join-Path $liveRoot 'LatAmCollector.exe'
        if ($server.Path -ne $exe) {
            $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$serverId"
            if ($server.ProcessName -notin @('python', 'pythonw') -or $owner.CommandLine -notmatch '(?i)\blauncher\.py\b') {
                throw 'Cannot verify that the running process belongs to LatAmCollector.'
            }
        }
        $stop += $server
    }
    $stop += @(Get-Process -Name LatAmCollector -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $roots -contains (Split-Path -Parent $_.Path)
    })

    $shell = New-Object -ComObject WScript.Shell
    $desktopShortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'LatAmCollector.lnk'
    $startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'LatAmCollector-AutoStart.lnk'
    $shortcuts = @(@($desktopShortcut, $startupShortcut) | Where-Object {
        if (!(Test-Path -LiteralPath $_ -PathType Leaf)) { return $false }
        $shortcut = $shell.CreateShortcut($_)
        foreach ($root in $roots) {
            if (([string]$shortcut.TargetPath).StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or
                ([string]$shortcut.Arguments).IndexOf($root + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                return $true
            }
        }
        return $false
    })
    foreach ($link in @($desktopShortcut, $startupShortcut)) {
        if ((Test-Path -LiteralPath $link -PathType Leaf) -and $shortcuts -notcontains $link) {
            throw "This shortcut points outside the verified installations: $link"
        }
    }

    $parent = Split-Path -Parent $target
    $installer = Find-Setup $parent
    $tag = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
    $archives = @{}
    foreach ($root in @($roots + $target | Sort-Object -Unique)) {
        $backup = Join-Path (Split-Path -Parent $root) ("LatAmCollector-Backup-$tag")
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        $archives[$root] = $backup
    }
    $primary = $archives[$target]
    $snapshot = $null

    try {
        foreach ($root in $roots) {
            if ($location -eq $root -or $location.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
                Set-Location -LiteralPath $parent
                break
            }
        }
        Write-Host 'Stopping the verified LatAmCollector processes...'
        foreach ($process in $stop | Sort-Object Id -Unique) {
            if (!$process.HasExited) {
                Stop-Process -InputObject $process
                if (!$process.WaitForExit(15000)) { throw "LatAmCollector PID $($process.Id) did not stop." }
            }
        }
        if (Read-Platform) { throw 'The old platform is still running.' }

        Write-Host 'Saving the existing libraries...'
        foreach ($root in $roots) {
            $data = Join-Path $root 'data'
            if (Test-Path -LiteralPath $data -PathType Container) {
                $saved = Join-Path $archives[$root] 'data'
                Move-Item -LiteralPath $data -Destination $saved
                if ($root -eq $target) { $snapshot = $saved }
            }
        }

        Write-Host 'Uninstalling the old program and moving remaining files aside...'
        foreach ($uninstaller in $uninstallers) {
            $process = Start-Process -FilePath $uninstaller -ArgumentList '/SILENT /NORESTART' -Wait -PassThru
            if ($process.ExitCode -ne 0) { throw "The old uninstaller returned $($process.ExitCode)." }
        }
        foreach ($link in $shortcuts) {
            if (Test-Path -LiteralPath $link -PathType Leaf) {
                Move-Item -LiteralPath $link -Destination $primary
            }
        }
        foreach ($root in $roots) {
            if (Test-Path -LiteralPath $root -PathType Container) {
                Move-Item -LiteralPath $root -Destination (Join-Path $archives[$root] 'old-program')
            }
        }

        Write-Host "Installing v$version in $target..."
        $log = Join-Path $primary 'install.log'
        $setupArgs = @('/SILENT', '/SP-', '/NORESTART', ('/DIR="' + $target + '"'), ('/LOG="' + $log + '"'))
        if ($shortcuts -contains $startupShortcut) { $setupArgs += '/TASKS=autostart' }
        $process = Start-Process -FilePath $installer -ArgumentList $setupArgs -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "Installation returned $($process.ExitCode). See $log" }
        Restore-Library $snapshot $target

        Start-Process -FilePath (Join-Path $target 'LatAmCollector.exe') -ArgumentList '--no-browser' -WorkingDirectory $target
        $deadline = [DateTime]::UtcNow.AddSeconds(75)
        do {
            $new = Read-Platform
            if ($new) { break }
            Start-Sleep -Milliseconds 500
        } while ([DateTime]::UtcNow -lt $deadline)
        if (!$new -or $new.version -ne $version -or
            $new.database -ne (Join-Path $target 'data\latam_collector.db')) {
            throw "The new service did not start with the expected version and database. See $log"
        }
        $page = Invoke-WebRequest -Uri $base -UseBasicParsing -TimeoutSec 5
        $helper = Get-Content -LiteralPath (Join-Path $target 'chrome_extension\manifest.json') -Raw | ConvertFrom-Json
        if ($page.Content -notlike '*id="review-start"*' -or $helper.version -ne $version) {
            throw 'The review button or current Chrome helper files were not found.'
        }

        $oldPackagesPattern = '^LatAmCollector(?:-Setup-0\.[0-7]\.\d+-x64\.exe|-(?:Chrome|Radar|Windows)-v0\.[0-7](?:\.\d+)?\.zip|(?:_Windows)?_v0\.[0-7](?:\.\d+)?\.zip)$'
        foreach ($folder in @($downloads, $legacyParent, $parent) | Sort-Object -Unique) {
            if (!(Test-Path -LiteralPath $folder -PathType Container)) { continue }
            foreach ($file in Get-ChildItem -LiteralPath $folder -File -ErrorAction SilentlyContinue) {
                if ($file.Name -notmatch $oldPackagesPattern) { continue }
                $destination = Join-Path $primary ('old-package-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '-' + $file.Name)
                try { Move-Item -LiteralPath $file.FullName -Destination $destination }
                catch { Write-Warning "Could not move this old package: $($file.FullName)" }
            }
        }

        Write-Host "LatAmCollector v$version is running. Open $base in Chrome." -ForegroundColor Green
        Write-Host 'Verified the review capture button and Chrome helper files.'
        Write-Host 'Backup locations'
        $archives.Values | Sort-Object -Unique | ForEach-Object { Write-Host $_ }
    }
    catch {
        if ($snapshot -and !(Test-Path -LiteralPath (Join-Path $target 'data\latam_collector.db'))) {
            try { Restore-Library $snapshot $target }
            catch { Write-Warning "The original library is saved in $snapshot" }
        }
        Write-Warning "The cleanup did not finish. The main backup is at $primary"
        throw
    }
}
