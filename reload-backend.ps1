# 轻量重载后端：重建 lma-agent 镜像并仅重启 agent 容器
# postgres / redis 不动，会话数据（Postgres volume）零影响。
# 用法：项目根目录执行  .\reload-backend.ps1
# 可选参数：-NoBuild 只重启容器不重建镜像（代码未变时用，更快）

param(
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$BackendDir = Join-Path $ProjectRoot 'backend'
$ImageTag = 'lma-agent:latest'

# Windows 中文控制台（GBK）下 langgraph CLI 输出 emoji/中文会 UnicodeEncodeError，
# 强制 UTF-8 后再调用
$env:PYTHONIOENCODING = 'utf-8'

function Write-Step($msg) { Write-Host "[reload] $msg" -ForegroundColor Cyan }

# 1. 重建镜像（依赖层缓存命中时仅需数秒）
if (-not $NoBuild) {
    Write-Step "building image $ImageTag ..."
    Push-Location $BackendDir
    try {
        & .\.venv\Scripts\langgraph.exe build -t $ImageTag
        if ($LASTEXITCODE -ne 0) { throw "langgraph build failed (exit $LASTEXITCODE)" }
    }
    finally { Pop-Location }
}

# 2. 重建 agent 容器（compose 会因镜像更新自动 recreate）
Write-Step "recreating lma-agent container ..."
docker compose --env-file backend/.env up -d lma-agent
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed (exit $LASTEXITCODE)" }

# 3. 等待服务就绪（License 校验 + 迁移检查约需 10~20 秒）
Write-Step "waiting for http://127.0.0.1:2024/ok ..."
$ok = $false
foreach ($i in 1..30) {
    Start-Sleep -Seconds 2
    try {
        $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:2024/ok' -UseBasicParsing -TimeoutSec 5
        if ($resp.Content -match '"ok"\s*:\s*true') { $ok = $true; break }
    } catch { <# 尚未就绪，继续等待 #> }
}
if (-not $ok) {
    Write-Host "[reload] FAILED: service not ready in 60s, recent logs:" -ForegroundColor Red
    docker logs --tail 30 lma-lma-agent-1
    exit 1
}

Write-Host "[reload] done: backend is live at http://127.0.0.1:2024" -ForegroundColor Green
