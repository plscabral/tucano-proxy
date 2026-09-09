param(
    [string]$Version = $(if ($env:TUCANO_VERSION) { $env:TUCANO_VERSION } else { 'latest' }),
    [string]$InstallDir = $(if ($env:TUCANO_INSTALL_DIR) { $env:TUCANO_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'TucanoProxy\bin' })
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repository = 'plscabral/tucano-proxy'
$destination = Join-Path $InstallDir 'tucano-proxy.exe'
$updating = Test-Path -LiteralPath $destination
$action = if ($updating) { 'Updating' } else { 'Installing' }
$result = if ($updating) { 'updated' } else { 'installed' }
$command = "& '" + $destination.Replace("'", "''") + "'"
$interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected -and -not $env:CI
if ($Version -eq 'latest') {
    $base = "https://github.com/$repository/releases/latest/download"
} elseif ($Version -match '^v[0-9][A-Za-z0-9._-]*$') {
    $base = "https://github.com/$repository/releases/download/$Version"
} else {
    throw 'Version must be latest or a release tag such as v0.2.6'
}
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($architecture -notin @('AMD64', 'ARM64')) { throw 'The published Windows CLI requires x64 or Windows ARM64 x64 emulation.' }
$asset = 'tucano-proxy-x86_64-pc-windows-msvc.zip'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('tucano-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $archive = Join-Path $temp $asset
    Write-Host "$action $asset · $Version" -ForegroundColor DarkGray
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $archive -TimeoutSec 300 -MaximumRedirection 5
    } catch {
        throw "Standalone CLI archive unavailable for this release/platform. Desktop assets cannot be used as CLI updates; the current installation was not changed. $($_.Exception.Message)"
    }
    $checksumPath = Join-Path $temp 'checksum'
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset.sha256" -OutFile $checksumPath -TimeoutSec 60 -MaximumRedirection 5
    $expected = ((Get-Content -Raw $checksumPath).Trim() -split '\s+')[0]
    if ($expected -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid SHA-256 file' }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash
    if ($actual -ine $expected) { throw 'SHA-256 mismatch; the current installation was not changed' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $entries = @($zip.Entries | Where-Object { $_.FullName -ceq 'tucano-proxy.exe' })
        if ($entries.Count -ne 1) { throw 'Archive must contain exactly one root tucano-proxy.exe executable' }
        $entry = $entries[0]
        $fileType = ($entry.ExternalAttributes -shr 16) -band 0xF000
        if ($fileType -notin @(0, 0x8000) -or $entry.Length -eq 0 -or $entry.Length -gt 268435456) {
            throw 'Executable archive member is not a regular, non-empty file within the size limit'
        }
        $binary = Join-Path $temp 'tucano-proxy.exe'
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $binary, $false)
    } finally { $zip.Dispose() }
    $downloadedVersion = (& $binary --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Downloaded executable could not run on this machine' }
    if ($downloadedVersion -notmatch '^tucano-proxy [0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?$') {
        throw 'Downloaded file is not a Tucano Proxy CLI executable'
    }
    if ($Version -ne 'latest' -and $downloadedVersion -cne "tucano-proxy $($Version.Substring(1))") {
        throw 'Downloaded executable version does not match the requested release'
    }
    $versionNumber = $downloadedVersion -replace '^tucano-proxy ', ''
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $staged = Join-Path $InstallDir ('.tucano-proxy-' + [Guid]::NewGuid().ToString('N') + '.exe')
    Copy-Item -LiteralPath $binary -Destination $staged
    try {
        if (Test-Path -LiteralPath $destination) {
            [IO.File]::Replace($staged, $destination, $null)
        } else {
            [IO.File]::Move($staged, $destination)
        }
    } catch {
        Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $staged
        throw "Could not replace the executable. If it is in use, try the native updater: $command update. No session was stopped. $($_.Exception.Message)"
    }
    Write-Host ''
    Write-Host "Tucano Proxy $versionNumber " -NoNewline
    Write-Host $result -ForegroundColor DarkGray
    Write-Host ('  {0,-12}{1}' -f 'executable', $destination)
    if (($env:PATH -split ';') -notcontains $InstallDir) {
        Write-Host ('  {0,-12}{1} (add it to your user PATH)' -f 'not on PATH', $InstallDir)
    }
    Write-Host ''
    & $destination setup --status
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ! Certificate status could not be determined. Run: $command setup --status" -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host 'Next'
    Write-Host "  $command setup" -NoNewline; Write-Host '  guided first use' -ForegroundColor DarkGray
    Write-Host "  $command update --check" -NoNewline; Write-Host '  check for a newer CLI' -ForegroundColor DarkGray
    Write-Host "  $command update" -NoNewline; Write-Host '  replace this executable (--yes for automation)' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host 'Only the executable changed: certificate trust, system proxy, session data, skills and PATH were untouched.' -ForegroundColor DarkGray
    if ($updating) {
        Write-Host 'Running services keep their previous version until you stop and start them.' -ForegroundColor DarkGray
    }
    # Never launch a prompt from an installer that may have been piped to Invoke-Expression.
    if (-not $interactive) {
        Write-Host 'Setup needs an interactive terminal; run the setup command above when you have one.' -ForegroundColor DarkGray
    }
} finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $temp
}
