param([Parameter(Mandatory)][string]$SetupFile)

$ErrorActionPreference = 'Stop'
$setup = (Resolve-Path -LiteralPath $SetupFile).Path
$installDir = Join-Path $env:RUNNER_TEMP ('LatAm Collector ' + [char]0x6D4B)
$exe = Join-Path $installDir 'LatAmCollector.exe'
$pidFile = Join-Path $installDir 'data\server.pid'
$database = Join-Path $installDir 'data\latam_collector.db'
$url = 'http://127.0.0.1:8765'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'LatAmCollector.lnk'
$startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'LatAmCollector-AutoStart.lnk'
$setupLog = Join-Path $env:RUNNER_TEMP 'latam-setup-test.log'
$service = $null
$verified = $false

function Install-Setup {
    $setupArgs = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=autostart', "/DIR=`"$installDir`"", "/LOG=`"$setupLog`"")
    $process = Start-Process -FilePath $setup -ArgumentList $setupArgs -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Setup exited with code $($process.ExitCode)." }
}

function Wait-For-Service {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        try {
            $response = Invoke-WebRequest -Uri "$url/api/system" -UseBasicParsing -TimeoutSec 2
            return ([Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()) | ConvertFrom-Json)
        }
        catch { Start-Sleep -Milliseconds 350 }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The installed app did not respond on port 8765.'
}

function Stop-TestService($process) {
    if (Test-Path -LiteralPath $pidFile) {
        $serverProcess = Get-Process -Id ([int](Get-Content -LiteralPath $pidFile -Raw)) -ErrorAction SilentlyContinue
        if ($serverProcess -and $serverProcess.Path -eq $exe) { Stop-Process -Id $serverProcess.Id }
    }
    if ($process -and -not $process.WaitForExit(10000)) { Stop-Process -Id $process.Id }
}

try {
    Install-Setup
    $expectedManifest = Get-Content "$PSScriptRoot\..\chrome_extension\manifest.json" -Raw | ConvertFrom-Json
    $manifest = Get-Content "$installDir\chrome_extension\manifest.json" -Raw | ConvertFrom-Json
    if ($manifest.version -ne $expectedManifest.version -or -not (Test-Path "$installDir\chrome_extension\queue.html")) {
        throw 'The installer did not place the Chrome helper files.'
    }
    foreach ($shortcut in @($desktopShortcut, $startupShortcut)) {
        if (-not (Test-Path -LiteralPath $shortcut)) { throw "Missing shortcut at $shortcut" }
    }

    $service = Start-Process -FilePath $desktopShortcut -PassThru
    $system = Wait-For-Service
    if ($system.database -ne $database) { throw "Unexpected database path $($system.database), expected $database." }
    $dashboardResponse = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
    if ($dashboardResponse.StatusCode -ne 200 -or $dashboardResponse.Content -notlike '*LatAm*') { throw 'The radar page is missing.' }
    $other = Start-Process -FilePath $exe -ArgumentList '--no-browser' -PassThru
    if (-not $other.WaitForExit(20000) -or $other.ExitCode -ne 0) {
        if (-not $other.HasExited) { Stop-Process -Id $other.Id }
        throw 'A second launch did not reuse the running service.'
    }

    $fixture = @{
        source_url = 'https://shopee.com.br/api/v4/search/search_items'
        payload = @{items = @(@{itemid = 441; shopid = 12; name = 'Caneta'; price = 3200000})}
    } | ConvertTo-Json -Depth 5
    $capture = Invoke-RestMethod -Uri "$url/api/capture" -Method Post -ContentType 'application/json' -Body $fixture
    if ($capture.new_products -ne 1) { throw 'The installed app could not save the test product.' }
    Stop-TestService $service
    $service = $null

    Install-Setup
    $service = Start-Process -FilePath $startupShortcut -PassThru
    Wait-For-Service | Out-Null
    $stats = Invoke-RestMethod -Uri "$url/api/stats"
    if ($stats.products -ne 1) { throw 'Reinstalling did not preserve the product library.' }
    Stop-TestService $service
    $service = $null

    $uninstaller = Get-ChildItem -LiteralPath $installDir -Filter 'unins*.exe' | Select-Object -First 1
    $removed = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -Wait -PassThru
    if ($removed.ExitCode -ne 0 -or (Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath $database)) {
        throw 'The uninstaller did not remove the app and preserve the product library.'
    }
    $verified = $true
    Write-Host 'Verified Windows installation, shortcuts, Chrome files, startup, capture, reinstall and uninstall.'
}
finally {
    Stop-TestService $service
    if (-not $verified -and (Test-Path -LiteralPath $setupLog)) { Get-Content -LiteralPath $setupLog -Tail 55 }
    if (Test-Path "$installDir\data\startup.log") { Get-Content "$installDir\data\startup.log" -Tail 30 }
}
