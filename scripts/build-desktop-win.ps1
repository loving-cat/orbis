# Build and install the Windows desktop helper (native/orbis-desktop-win).
#
# Why a separate script: pack-windows.ps1 stays pure ASCII, offline and
# toolchain-free. Compiling Rust needs cargo + MSVC build tools, so the helper is
# built (and optionally signed) ahead of time and shipped alongside.
#
# Usage:
#   .\scripts\build-desktop-win.ps1                    # build into server/resources/
#   .\scripts\build-desktop-win.ps1 -Check             # verify toolchain + artifact only
#   .\scripts\build-desktop-win.ps1 -Out D:\somewhere  # custom output dir

param(
  [string]$Out = "",
  [switch]$Check,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Fail([string]$message) {
  Write-Host "ERROR: $message" -ForegroundColor Red
  exit 1
}

if ($Help) {
  Write-Host "build-desktop-win.ps1 [-Out <dir>] [-Check]"
  Write-Host ""
  Write-Host "  -Out    output directory (default: server/resources)"
  Write-Host "  -Check  verify toolchain and existing artifact only, do not build"
  exit 0
}
if ($args.Count -gt 0) { Fail "unknown parameter" }

$root = Split-Path -Parent $PSScriptRoot
$crate = Join-Path $root "native\orbis-desktop-win"
$cargoToml = Join-Path $crate "Cargo.toml"
if (-not (Test-Path -LiteralPath $cargoToml)) { Fail "missing native/orbis-desktop-win/Cargo.toml" }

if (-not $Out) { $Out = Join-Path $root "server\resources" }
$exe = Join-Path $Out "orbis-desktop-win.exe"
$sha = Join-Path $Out "orbis-desktop-win.sha256"

function Get-ExpectedVersion {
  $line = Select-String -LiteralPath $cargoToml -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
  if (-not $line) { Fail "cannot read version from Cargo.toml" }
  return $line.Matches[0].Groups[1].Value
}
$version = Get-ExpectedVersion
Write-Host "desktop helper version: $version"

if ($Check) {
  if (-not (Test-Path -LiteralPath $exe)) { Fail "helper not built: $exe" }
  $reported = (& $exe version 2>&1) -join " "
  Write-Host "reported: $reported"
  if ($reported -notmatch [regex]::Escape($version)) { Fail "version mismatch" }
  $want = (Get-Content -LiteralPath $sha -Raw -ErrorAction SilentlyContinue)
  if ($want) {
    $got = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $want.Trim().ToLower().Split(" ")[0]) { Fail "sha256 mismatch" }
    Write-Host "sha256 ok"
  }
  Write-Host "OK"
  exit 0
}

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) { Fail "cargo is not on PATH; install Rust (winget install Rustlang.Rustup) and reopen the shell" }

# rustup installs the msvc toolchain, which needs the MSVC linker.
$linkers = @(
  "C:\Program Files\Microsoft Visual Studio\2022\*\VC\Tools\MSVC\*\bin\Hostx64\x64\link.exe",
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\*\VC\Tools\MSVC\*\bin\Hostx64\x64\link.exe"
)
$hasLinker = $false
foreach ($pattern in $linkers) {
  if (Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue) { $hasLinker = $true; break }
}
if (-not $hasLinker) {
  Fail "MSVC link.exe not found; install Visual Studio 2022 Build Tools with the C++ desktop workload"
}

Push-Location $crate
try {
  Write-Host "== cargo test --release =="
  & cargo test --release
  if ($LASTEXITCODE -ne 0) { throw "cargo test failed ($LASTEXITCODE)" }
  Write-Host "== cargo build --release =="
  & cargo build --release
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }
  Write-Host "== version self check =="
  $reported = (& (Join-Path $crate "target\release\orbis-desktop-win.exe") version 2>&1) -join " "
  if ($reported -notmatch [regex]::Escape($version)) { throw "version mismatch: $reported" }
  # Keep the Node side in sync: it refuses to use a helper whose version differs
  # from DESKTOP_HELPER_VERSION (and falls back to PowerShell when it does).
  & node (Join-Path $root "server\tools\check-desktop-helper-version.mjs") (Join-Path $crate "target\release\orbis-desktop-win.exe")
  if ($LASTEXITCODE -ne 0) { throw "helper version does not match server/src/desktop-helper-win.js" }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Path $Out -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $crate "target\release\orbis-desktop-win.exe") -Destination $exe -Force
$hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower()
# Manifest format matches `sha256sum`: <hash>  <name>
Set-Content -LiteralPath $sha -Value "$hash  orbis-desktop-win.exe" -Encoding ASCII -NoNewline

Write-Host "wrote $exe"
Write-Host "wrote $sha ($hash)"
