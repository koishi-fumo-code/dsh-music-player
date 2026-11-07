# =============================================================================
#  dsh-music-player - installer for Windows (pure ASCII; see install.ps1 notes)
#  Finds Node, then hands off to scripts/install.mjs which does the real work.
# =============================================================================
$ErrorActionPreference = 'Stop'

function Write-Info($msg) { Write-Host "  $msg" }
function Write-Step($msg) { Write-Host ""; Write-Host "== $msg" }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

Write-Host ""
Write-Host "  dsh-music-player - local music player for DeepSeek Harness"
Write-Host "  ---------------------------------------------------------"

Write-Step "1/3 Looking for Node.js"

function Test-NodeExe($p) {
  if (-not $p) { return $null }
  if (-not (Test-Path -LiteralPath $p)) { return $null }
  try {
    $v = & $p -e "process.versions.node.split('.')[0]" 2>$null
    if ($LASTEXITCODE -eq 0 -and [int]$v -ge 22) { return $p }
  } catch { }
  return $null
}

$candidates = New-Object System.Collections.Generic.List[string]

# a) PATH
$onPath = Get-Command node -ErrorAction SilentlyContinue
if ($onPath) { $candidates.Add($onPath.Source) }

# b) bundled DSH runtime (varies by install root)
$roots = @()
try {
  $proc = Get-Process -Name 'DeepSeek Harness','dsh','electron' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($proc -and $proc.Path) { $roots += (Split-Path -Parent $proc.Path) }
} catch { }
$roots += @(
  "$env:LOCALAPPDATA\Programs\DeepSeek Harness",
  "$env:ProgramFiles\DeepSeek Harness",
  "${env:ProgramFiles(x86)}\DeepSeek Harness",
  "D:\deepseekharness",
  "C:\deepseekharness"
)
foreach ($r in $roots) {
  if (-not $r -or -not (Test-Path -LiteralPath $r)) { continue }
  Get-ChildItem -LiteralPath $r -Recurse -Depth 5 -Filter 'node.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 5 | ForEach-Object { $candidates.Add($_.FullName) }
}

$node = $null
foreach ($c in $candidates) {
  $hit = Test-NodeExe $c
  if ($hit) { $node = $hit; break }
}

if (-not $node) {
  Write-Host ""
  Write-Host "  [X] Node.js 22+ not found." -ForegroundColor Red
  Write-Host "      Install Node from https://nodejs.org (LTS), then run install.cmd again."
  Write-Host "      If DeepSeek Harness is installed somewhere unusual, run this instead:"
  Write-Host "        node scripts\install.mjs"
  exit 1
}
Write-Info "Node: $node"

Write-Step "2/3 Installing into every DSH profile"

& $node "$here\scripts\install.mjs" @args
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "  [X] install.mjs failed (exit $LASTEXITCODE)." -ForegroundColor Red
  exit $LASTEXITCODE
}

Write-Step "3/3 Done"

Write-Host ""
Write-Host "  Next: restart DeepSeek Harness completely, then:"
Write-Host "    * left icon rail -> a new music note icon"
Write-Host "    * Settings -> Music player  (equalizer / DSD / buffer)"
Write-Host ""
Write-Host "  Uninstall:  node scripts\install.mjs --uninstall"
Write-Host ""
