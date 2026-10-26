<#
.SYNOPSIS
  用 claude:// 深链把一条任务投递给 Claude 桌面端（不装 DSH 也能用）。

.EXAMPLE
  .\deeplink.ps1 -Prompt "把 README 第一段改短" -Folder E:\path\to\repo
.EXAMPLE
  .\deeplink.ps1 -Prompt "修一下 lint" -Folder E:\proj -Surface code -DryRun
.EXAMPLE
  .\deeplink.ps1 -Surface continue -Session last
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Prompt,
  [string]$Folder,
  [string[]]$Files,
  [ValidateSet('code', 'cowork', 'claude.ai', 'continue', 'needs-input')][string]$Surface = 'code',
  [string]$Session,
  [int]$MaxPromptChars = 6000,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function New-Link {
  param([hashtable]$Params, [string]$HostName, [string]$Path)
  $pairs = foreach ($k in $Params.Keys) {
    foreach ($v in @($Params[$k])) {
      if ($null -ne $v -and "$v" -ne '') { '{0}={1}' -f $k, [uri]::EscapeDataString([string]$v) }
    }
  }
  $qs = ($pairs -join '&')
  $url = "claude://$HostName$Path"
  if ($qs) { $url = "$url`?$qs" }
  return $url
}

$clean = $null
if ($Prompt) {
  $clean = ($Prompt -replace '[\x00-\x08\x0B\x0C\x0E-\x1F]', ' ').Trim()
  if ($clean.Length -gt $MaxPromptChars) {
    Write-Warning "prompt 超过 $MaxPromptChars 字，已截断"
    $clean = $clean.Substring(0, $MaxPromptChars)
  }
}

$abs = $null
if ($Folder) {
  $abs = (Resolve-Path -LiteralPath $Folder -ErrorAction SilentlyContinue).Path
  if (-not $abs) { $abs = [IO.Path]::GetFullPath($Folder); Write-Warning "目录不存在：$abs" }
}

switch ($Surface) {
  'code' {
    $url = New-Link @{ q = $clean; folder = $abs; file = $Files; source = 'desktop_action' } 'code' '/new'
  }
  'cowork' {
    $url = New-Link @{ q = $clean; folder = $abs; file = $Files; source = 'desktop_action' } 'cowork' '/new'
  }
  'claude.ai' {
    $url = New-Link @{ surface = 'chat' } 'claude.ai' '/new'
  }
  'continue' {
    if (-not $Session) { $Session = 'last' }
    if ($Session -ne 'last' -and $Session -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
      throw "Session 必须是 last 或 UUID 形态的会话 id：$Session"
    }
    $url = New-Link @{ session = $Session; source = 'desktop_action' } 'code' '/continue'
  }
  'needs-input' {
    $url = New-Link @{ source = 'desktop_action' } 'code' '/needs-input'
  }
}

if ($url -notlike 'claude://*') { throw "拒绝启动非 claude:// 的 URL：$url" }

Write-Host "[deeplink] $url"
if ($DryRun) { Write-Host '[deeplink] dry-run，未启动'; return }

# ShellExecute，不经 shell 解析，URL 里的 & 不会被拆
Start-Process -FilePath 'rundll32.exe' -ArgumentList 'url.dll,FileProtocolHandler', $url
Write-Host '[deeplink] 已投递（结果留在桌面端，读不回来）'