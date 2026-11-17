# Runs elevated via the "wsl-ai-center proxy" scheduled task (created by setup.ps1) from
# %ProgramFiles%\wsl-ai-center, with fixed arguments. Reads no config and no user-writable path.
# Forwards <Windows IP on the WSL network>:<port> -> 127.0.0.1:<port>.

param(
  [Parameter(Mandatory)][int]$Port,
  [Parameter(Mandatory)][string]$InterfaceAlias,
  [Parameter(Mandatory)][string]$LogFile
)

# The task inherits the user's PSModulePath (user-writable Documents\WindowsPowerShell\Modules).
# Cmdlets below autoload modules, so a planted module would run elevated: use system modules only.
$env:PSModulePath = Join-Path $PSHOME 'Modules'

$ErrorActionPreference = 'Stop'
$NETSH = Join-Path $env:SystemRoot 'System32\netsh.exe'

function Write-Log([string]$message) {
  "$((Get-Date).ToString('s', [Globalization.CultureInfo]::InvariantCulture)) $message" | Out-File -LiteralPath $LogFile -Append -Encoding utf8
}

function Remove-StaleProxies([int]$port) {
  # Old entries may point to a WSL IP from a previous boot
  $listing = & $NETSH interface portproxy show v4tov4 2>&1
  if ($LASTEXITCODE -ne 0) { throw "netsh show failed: $($listing -join ' ')" }
  $listing |
    Select-String "^\s*(\S+)\s+$port\s" |
    ForEach-Object {
      $listenAddress = $_.Matches[0].Groups[1].Value
      $output = & $NETSH interface portproxy delete v4tov4 listenaddress=$listenAddress listenport=$port 2>&1
      if ($LASTEXITCODE -ne 0) { throw "netsh delete failed for ${listenAddress}:${port}: $($output -join ' ')" }
    }
}

try {
  $alias = $InterfaceAlias

  # portproxy depends on the IP Helper service
  Start-Service -Name iphlpsvc

  $address = Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias $alias -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1
  if (-not $address) {
    Write-Log "ERROR: interface '$alias' not found. Is WSL running?"
    exit 1
  }
  $hostIp = $address.IPAddress

  Remove-StaleProxies $Port
  $output = & $NETSH interface portproxy add v4tov4 listenaddress=$hostIp listenport=$Port `
    connectaddress=127.0.0.1 connectport=$Port 2>&1
  if ($LASTEXITCODE -ne 0) { throw "netsh add failed: $($output -join ' ')" }
  Write-Log "OK: $($hostIp):$Port -> 127.0.0.1:$Port"
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  exit 1
}
