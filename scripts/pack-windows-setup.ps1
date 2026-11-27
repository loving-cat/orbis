# Build the Windows installer (setup.exe) from an already packed folder.
#
#   .\scripts\pack-windows-setup.ps1              # dist/orbis-windows-v<ver>-setup.exe
#   .\scripts\pack-windows-setup.ps1 -Help        # this text
#
# Input is dist/orbis-windows, which scripts/pack-windows.ps1 produces. This
# script never builds Flutter and never installs dependencies: run the folder
# pack first, so the installer wraps exactly the bytes that were scanned there
# (no user paths, no .pdb, no local state).
#
# Inno Setup 6 is required; install it with
#   winget install JRSoftware.InnoSetup
# ISCC.exe is looked up in PATH, then in the usual install locations.
#
# The setup.exe is per-user (no admin prompt) and installs to
# %LOCALAPPDATA%\Programs\Orbis. User data in %LOCALAPPDATA%\Orbis is never
# touched, so installing over an older version keeps pairings and history.
#
# Keep this file ASCII-only. PowerShell 5.1 decodes BOM-less scripts as ANSI.

param(
  [string]$Bundle = "dist/orbis-windows",
  [string]$OutDir = "dist",
  [string]$Iscc = "",
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Fail([string]$message) {
  Write-Host "ERROR: $message" -ForegroundColor Red
  exit 1
}

function Get-FullPath([string]$Path) {
  $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
  return [System.IO.Path]::GetFullPath($resolved)
}

# ISCC.exe is not always on PATH: the winget package installs per-user.
function Find-Iscc([string]$explicit) {
  if ($explicit) {
    if (-not (Test-Path -LiteralPath $explicit -PathType Leaf)) { return $null }
    return (Get-Item -LiteralPath $explicit).FullName
  }
  $cmd = Get-Command ISCC.exe -CommandType Application -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $guesses = @()
  if ($env:LOCALAPPDATA) { $guesses += (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe") }
  if (${env:ProgramFiles(x86)}) { $guesses += (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe") }
  if ($env:ProgramFiles) { $guesses += (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe") }
  foreach ($guess in $guesses) {
    if (Test-Path -LiteralPath $guess -PathType Leaf) { return $guess }
  }
  return $null
}

if ($Help) {
  Write-Host @"
Build the Windows installer from the packed folder.

  .\scripts\pack-windows-setup.ps1
  .\scripts\pack-windows-setup.ps1 -Bundle dist\Orbis-windows -OutDir dist
  .\scripts\pack-windows-setup.ps1 -Iscc "C:\path\to\ISCC.exe"

Requires Inno Setup 6 (winget install JRSoftware.InnoSetup).
The bundle must already exist: run .\scripts\pack-windows.ps1 -WithNode -Zip first.
Produces dist/orbis-windows-v<version>-setup.exe.
"@
  exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$bundleDir = if ([System.IO.Path]::IsPathRooted($Bundle)) { $Bundle } else { Join-Path $root $Bundle }
$outRoot = if ([System.IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $root $OutDir }

if (-not (Test-Path -LiteralPath (Join-Path $bundleDir "orbis.exe"))) {
  Fail "no packed build at $Bundle (run scripts/pack-windows.ps1 first)"
}
if (-not (Test-Path -LiteralPath (Join-Path $bundleDir "server\src\index.js"))) {
  Fail "packed build has no server/src/index.js"
}
if (-not (Test-Path -LiteralPath (Join-Path $bundleDir "node.exe"))) {
  Write-Host "note: bundle has no node.exe - target machine will need Node 22+ on PATH"
}

$isccPath = Find-Iscc $Iscc
if (-not $isccPath) {
  Fail "ISCC.exe not found; install Inno Setup 6 (winget install JRSoftware.InnoSetup) or pass -Iscc"
}

$scriptPath = Join-Path $PSScriptRoot "installer\orbis.iss"
$languagePath = Join-Path $PSScriptRoot "installer\ChineseSimplified.isl"
$iconPath = Join-Path $root "app\windows\runner\resources\app_icon.ico"
foreach ($required in @($scriptPath, $languagePath, $iconPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { Fail "missing $required" }
}

# The installer wraps the BUNDLE, so its version must come from the bundle -
# not from the source checkout. Reading the checkout made it possible to build
# an installer named v2.0.0-rc.1 that actually ships a v2.0.0-beta.1 bundle
# whenever the checkout was bumped but the folder was not re-packed.
$bundlePkg = Join-Path $bundleDir "server\package.json"
if (-not (Test-Path -LiteralPath $bundlePkg -PathType Leaf)) {
  Fail "packed build has no server/package.json: $bundlePkg"
}
$version = (& node -e "const p=require(process.argv[1]);process.stdout.write(String(p.version||''))" $bundlePkg).Trim()
if (-not $version) { Fail "could not read server version from the bundle" }
if ($LASTEXITCODE -ne 0) { Fail "reading server version failed ($LASTEXITCODE)" }

# The name on the box has to match the app inside it. orbis.exe carries its own
# Flutter version resource; when that disagrees with the bundle's server version
# the bundle is stale (or the two were built at different times) - refuse.
# A bundle whose orbis.exe has no version resource at all (fixture stub, or a
# hand-assembled folder) cannot lie about its version this way, so warn and go on.
$exeVersion = ""
try { $exeVersion = (Get-Item -LiteralPath (Join-Path $bundleDir "orbis.exe")).VersionInfo.ProductVersion } catch { $exeVersion = "" }
if (-not $exeVersion) {
  Write-Host "WARNING: $bundleDir\orbis.exe has no ProductVersion; skipping the bundle/exe version cross-check" -ForegroundColor Yellow
} elseif ($exeVersion -notmatch ('^' + [regex]::Escape($version) + '([+]|$)')) {
  Fail "bundle version mismatch: server/package.json says $version, orbis.exe says $exeVersion (re-pack with scripts/pack-windows.ps1)"
} else {
  Write-Host "bundle version: $version (orbis.exe $exeVersion)"
}

$setupName = "orbis-windows-v$version-setup.exe"
$setupPath = Join-Path $outRoot $setupName

# Windows PE only accepts a numeric A.B.C.D file version. Pre-release versions
# (2.0.0-alpha.1) must stay in AppVersion / artifact name / uninstall entry, but
# passing them to VersionInfoVersion makes ISCC fail, so derive a numeric one:
# 2.0.0-alpha.1 -> 2.0.0.0.
$numeric = ($version -split '[-+]')[0]
$parts = @($numeric.Split('.'))
if ($parts.Count -ne 3 -or @($parts | Where-Object { $_ -notmatch '^\d+$' }).Count -gt 0) {
  Fail "cannot derive a numeric Windows file version from '$version' (expected X.Y.Z[+build])"
}
$appFileVersion = "$numeric.0"
New-Item -ItemType Directory -Path $outRoot -Force | Out-Null

# Build into a neutral temp dir, then move into place: a failed compile must not
# leave a half-written installer next to the previous good one.
$suffix = [guid]::NewGuid().ToString("N").Substring(0, 8)
$stageOut = Join-Path $outRoot (".setup-" + $suffix)
New-Item -ItemType Directory -Path $stageOut -Force | Out-Null

Write-Host "== compile installer ($version) =="
try {
  # ISCC resolves relative paths in the .iss against the .iss location, so every
  # path handed over here is absolute. Values with spaces are quoted by ISCC.
  & $isccPath `
    "/DAppVersion=$version" `
    "/DAppFileVersion=$appFileVersion" `
    "/DStageDir=$bundleDir" `
    "/DOutDir=$stageOut" `
    "/DIconFile=$iconPath" `
    $scriptPath
  if ($LASTEXITCODE -ne 0) { throw "ISCC failed ($LASTEXITCODE)" }

  $built = Join-Path $stageOut $setupName
  if (-not (Test-Path -LiteralPath $built -PathType Leaf)) {
    throw "ISCC reported success but $setupName is missing"
  }
  Move-Item -LiteralPath $built -Destination $setupPath -Force
} catch {
  Fail "$($_.Exception.Message)"
} finally {
  if (Test-Path -LiteralPath $stageOut) {
    Remove-Item -LiteralPath $stageOut -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$size = (Get-Item -LiteralPath $setupPath).Length
$hash = (Get-FileHash -LiteralPath $setupPath -Algorithm SHA256).Hash.ToLower()
Write-Host "setup: $setupPath"
Write-Host ("size: {0} bytes" -f $size)
Write-Host "sha256: $hash"
Write-Host "done"
