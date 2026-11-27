# Branch coverage for scripts/pack-windows-setup.ps1.
# This does not prove a real installed program; it proves the .iss compiles with
# a fixture bundle and that the failure branches stop early with a message.
# The file is ASCII-only so Windows PowerShell 5.1 can parse it.

$ErrorActionPreference = "Stop"
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script = Join-Path $PSScriptRoot "..\pack-windows-setup.ps1"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("orbis-setup-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$pass = 0

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

# Run the packer and capture exit code plus output, without letting a non-zero
# exit abort this test script.
function Invoke-Pack([string[]]$Arguments) {
  $out = Join-Path $testRoot ("out-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
  $all = @($Arguments) + @("-OutDir", $out)
  $text = & powershell -NoProfile -ExecutionPolicy Bypass -File $script @all 2>&1 | Out-String
  return @{ Code = $LASTEXITCODE; Text = $text; OutDir = $out }
}

function Find-TestIscc {
  $cmd = Get-Command ISCC.exe -CommandType Application -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $guesses = @()
  if ($env:LOCALAPPDATA) { $guesses += (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe") }
  if (${env:ProgramFiles(x86)}) { $guesses += (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe") }
  foreach ($guess in $guesses) {
    if (Test-Path -LiteralPath $guess -PathType Leaf) { return $guess }
  }
  return $null
}

try {
  # 1) No bundle at all: must fail and name the folder pack, not ISCC.
  $result = Invoke-Pack @("-Bundle", (Join-Path $testRoot "no-such-bundle"))
  Assert-True ($result.Code -ne 0) "missing bundle should exit non-zero"
  Assert-True ($result.Text -match "pack-windows.ps1") "missing bundle message should point at the folder pack"

  # 2) Bundle without server: still a broken input, still a clean stop.
  $bareBundle = Join-Path $testRoot "bare-bundle"
  New-Item -ItemType Directory -Path $bareBundle -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $bareBundle "orbis.exe") -Value "stub" -Encoding Ascii
  $result = Invoke-Pack @("-Bundle", $bareBundle)
  Assert-True ($result.Code -ne 0) "bundle without server should exit non-zero"
  Assert-True ($result.Text -match "server/src/index.js") "bundle without server should say what is missing"

  # 3) Bad -Iscc: refuse instead of silently skipping the installer.
  $fullBundle = Join-Path $testRoot "full-bundle"
  New-Item -ItemType Directory -Path (Join-Path $fullBundle "server\src") -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $fullBundle "orbis.exe") -Value "stub" -Encoding Ascii
  Set-Content -LiteralPath (Join-Path $fullBundle "server\src\index.js") -Value "// stub" -Encoding Ascii
  # The installer takes its version from the bundle now, so the fixture must
  # carry a server/package.json like a real pack output does.
  $repoVersion = (& node -e "process.stdout.write(require(process.argv[1]).version)" (Join-Path $repo "server\package.json")).Trim()
  $fixturePkg = @{ name = 'orbis-agent'; version = $repoVersion } | ConvertTo-Json -Compress
  Set-Content -LiteralPath (Join-Path $fullBundle "server\package.json") -Value $fixturePkg -Encoding Ascii
  $result = Invoke-Pack @("-Bundle", $fullBundle, "-Iscc", (Join-Path $testRoot "no-such-iscc.exe"))
  Assert-True ($result.Code -ne 0) "bad -Iscc should exit non-zero"
  Assert-True ($result.Text -match "ISCC.exe not found") "bad -Iscc should say ISCC is missing"

  # 3b) Bundle whose server/package.json disagrees with the app inside it: the
  # installer is named after the bundle version, so a stale folder here would
  # ship an installer that lies about what it contains. Must refuse.
  $staleBundle = Join-Path $testRoot "stale-bundle"
  New-Item -ItemType Directory -Path (Join-Path $staleBundle "server\src") -Force | Out-Null
  $builtExe = Join-Path $repo "app\build\windows\x64\runner\Release\orbis.exe"
  if (Test-Path -LiteralPath $builtExe) {
    Copy-Item -LiteralPath $builtExe -Destination (Join-Path $staleBundle "orbis.exe") -Force
    Set-Content -LiteralPath (Join-Path $staleBundle "server\src\index.js") -Value "// stub" -Encoding Ascii
    $stalePkg = @{ name = 'orbis-agent'; version = '9.9.9' } | ConvertTo-Json -Compress
    Set-Content -LiteralPath (Join-Path $staleBundle "server\package.json") -Value $stalePkg -Encoding Ascii
    $result = Invoke-Pack @("-Bundle", $staleBundle)
    Assert-True ($result.Code -ne 0) "version mismatch between bundle json and orbis.exe should exit non-zero"
    Assert-True ($result.Text -match "bundle version mismatch") "mismatch message should say which versions disagree"
  } else {
    Write-Output "SKIP mismatch branch (no Release orbis.exe to borrow a version resource from)"
  }
  Write-Output "OK error branches"

  # 4) Real compile with a fixture bundle. Skipped when Inno Setup is absent so
  # Linux/macOS CI and machines without the tool still pass the other branches.
  $iscc = Find-TestIscc
  if (-not $iscc) {
    Write-Output "SKIP compile (Inno Setup not installed)"
  } else {
    $result = Invoke-Pack @("-Bundle", $fullBundle, "-Iscc", $iscc)
    Assert-True ($result.Code -eq 0) "fixture compile should succeed: $($result.Text)"
    $version = $repoVersion
    $expected = Join-Path $result.OutDir ("orbis-windows-v$version-setup.exe")
    Assert-True (Test-Path -LiteralPath $expected) "expected $expected"
    Assert-True ($result.Text -match "sha256: [0-9a-f]{64}") "should print a sha256 for the installer"
    Assert-True (@(Get-ChildItem -LiteralPath $result.OutDir -Filter ".setup-*" -Force).Count -eq 0) "temp compile dir should be cleaned up"
    Write-Output "OK compile"
  }
} catch {
  Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output "pack-windows-setup tests passed"
