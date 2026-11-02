$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
try {
    $runningSettings = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/api/settings' -TimeoutSec 2
    if ($runningSettings.PSObject.Properties.Name -contains 'embedding_provider') {
        Write-Host 'The app is already running at http://127.0.0.1:8000' -ForegroundColor Cyan
        return
    }
} catch { }
$pythonPath = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python environment setup failed.' }
}
& $pythonPath -c "import importlib.util,sys; sys.exit(0 if all(importlib.util.find_spec(x) for x in ['fastapi','uvicorn','httpx','pypdf','chromadb','langchain_text_splitters','multipart']) else 1)"
if ($LASTEXITCODE -ne 0) {
    $pythonMinorVersion = & $pythonPath -c "import sys; print(sys.version_info.minor if sys.version_info.major == 3 else 0)"
    $dependencyFile = if ([int]$pythonMinorVersion -ge 12 -and (Test-Path -LiteralPath 'requirements-lock.txt')) { 'requirements-lock.txt' } else { 'requirements.txt' }
    & $pythonPath -m pip install -r $dependencyFile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
Write-Host ''
Write-Host 'Open http://127.0.0.1:8000 in your browser.' -ForegroundColor Cyan
Write-Host 'Keep this window open. Press Ctrl+C to stop.'
& $pythonPath -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
