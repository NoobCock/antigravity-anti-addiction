$ErrorActionPreference = 'Stop'

$repoUrl = 'https://github.com/NoobCock/antigravity-anti-addiction/archive/refs/heads/main.zip'
$python = if (Get-Command python -ErrorAction SilentlyContinue) { 'python' } elseif (Get-Command py -ErrorAction SilentlyContinue) { 'py' } else { throw '未检测到 Python 3，请先安装 Python 3 后重试。' }

$localManage = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'manage.py' } else { '' }
if ($localManage -and (Test-Path $localManage)) {
  & $python $localManage install
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  exit 0
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ag-anti-addiction-" + [Guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $tempRoot 'repo.zip'
$extractDir = Join-Path $tempRoot 'src'

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  Write-Host '正在下载 Anti Addiction 插件...' -ForegroundColor Cyan
  Invoke-WebRequest -Uri $repoUrl -OutFile $zipPath -UseBasicParsing
  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
  $rootDir = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
  if (-not $rootDir) { throw '安装包解压失败' }
  $managePy = Join-Path $rootDir.FullName 'manage.py'
  if (-not (Test-Path $managePy)) { throw '未找到 manage.py' }
  & $python $managePy install
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host '安装完成！若 Antigravity 侧边栏尚未出现，请重启一次 Antigravity。' -ForegroundColor Green
} finally {
  if (Test-Path $tempRoot) {
    Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
