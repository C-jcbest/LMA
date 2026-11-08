# 重建并重载新 lma-oss 后端；本机原 lma 项目及其会话卷保留不动。
param([switch]$NoBuild)

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not $NoBuild) {
        docker compose --env-file backend/.env build lma-agent migrate
        if ($LASTEXITCODE -ne 0) {
            throw '后端镜像构建失败，请查看上方日志。'
        }
    }
    docker compose --env-file backend/.env up -d --wait --wait-timeout 180 lma-agent
    if ($LASTEXITCODE -ne 0) {
        throw '新后端未就绪，请检查 docker compose logs lma-agent migrate。'
    }
    Write-Host '后端已就绪：http://127.0.0.1:2025/health'
}
finally {
    Pop-Location
}
