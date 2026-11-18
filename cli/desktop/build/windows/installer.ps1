# Builds DutyBoard-Setup.exe from installer.nsi, in the two stages its signatures need.
#
#   installer.ps1 -Stage uninstaller -Version 2.33.1 -Dir pkg    writes pkg\Uninstall.exe
#   (sign pkg\DutyBoard.exe and pkg\Uninstall.exe)
#   installer.ps1 -Stage installer   -Version 2.33.1 -Dir pkg    writes pkg\DutyBoard-Setup.exe
#
# -Dir holds DutyBoard.exe. -Product and -RunName are for trying it out without touching a real
# install: the name it installs under, and the sign-in entry it looks after.
#
# The release and CI both run this, so what CI proves is what a release does.
param(
  [Parameter(Mandatory)][ValidateSet('uninstaller', 'installer')][string]$Stage,
  [Parameter(Mandatory)][string]$Version,
  [Parameter(Mandatory)][string]$Dir,
  [string]$Product = '',
  [string]$RunName = ''
)
$ErrorActionPreference = 'Stop'

$nsis = if ($env:MAKENSIS) { $env:MAKENSIS } else { 'C:\Program Files (x86)\NSIS\makensis.exe' }
if (-not (Test-Path $nsis)) { throw "NSIS is not installed at $nsis" }
$dir = (Resolve-Path $Dir).Path
if (-not (Test-Path (Join-Path $dir 'DutyBoard.exe'))) { throw "$dir has no DutyBoard.exe" }

$defines = @("/DVERSION=$Version", "/DSRC=$dir")
if ($Product) { $defines += "/DPRODUCT=$Product" }
if ($RunName) { $defines += "/DRUN_NAME=$RunName" }

function Compile([string[]]$more) {
  $out = & $nsis /V2 @more @defines (Join-Path $PSScriptRoot 'installer.nsi') 2>&1
  $out | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) {
    # In the run's annotations too, which can be read without opening the log.
    $tail = (($out | Select-Object -Last 12) -join ' / ') -replace '[\r\n]+', ' '
    "::error title=makensis failed ($Stage)::$tail"
    throw "makensis failed with exit code $LASTEXITCODE"
  }
}

if ($Stage -eq 'uninstaller') {
  Compile @('/DUNINSTALLER_ONLY')
  # NSIS writes an uninstaller only by running an installer: this one does nothing else.
  $maker = Join-Path $dir 'make-uninstaller.exe'
  $made = Start-Process $maker -ArgumentList '/S' -Wait -PassThru
  if ($made.ExitCode -ne 0 -or -not (Test-Path (Join-Path $dir 'Uninstall.exe'))) { throw 'the uninstaller was not written' }
  Remove-Item $maker
} else {
  if (-not (Test-Path (Join-Path $dir 'Uninstall.exe'))) { throw "$dir has no Uninstall.exe: run -Stage uninstaller first" }
  Compile @()
  if (-not (Test-Path (Join-Path $dir 'DutyBoard-Setup.exe'))) { throw 'the installer was not written' }
}
