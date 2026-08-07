Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

$python = Join-Path $repoRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
  $python = 'python'
}

Set-Location (Join-Path $repoRoot 'backend')
& $python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload