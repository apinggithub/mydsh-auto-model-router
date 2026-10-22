<#
.SYNOPSIS
  Store, update or remove one credential reference in the DSH credential store.

.DESCRIPTION
  DSH resolves provider keys (and the quota watchdog's cloud keys) from
  $DSH_HOME/.credentials.yaml, under `refs:`. This script edits exactly one
  entry and leaves every other line untouched.

  The secret is read as a SecureString by default, so it never lands in the
  shell history, in a log, or in a chat transcript. Pass -FromFile to import an
  existing file and delete it afterwards.

.PARAMETER Name
  The reference name, e.g. ZHIPU_API_KEY, DEEPSEEK_API_KEY,
  ALIBABA_CLOUD_ACCESS_KEY_ID, ALIBABA_CLOUD_ACCESS_KEY_SECRET.

.PARAMETER Value
  Optional literal value for non-interactive use (machine provisioning).
  Prefer the prompt: a literal on the command line is recorded in history.

.PARAMETER FromFile
  Read the value from a file (trimmed), then delete that file.

.PARAMETER Remove
  Delete the reference instead of setting it.

.PARAMETER DshHome
  DSH home directory. Defaults to $env:DSH_HOME, then $HOME\.dsh.

.EXAMPLE
  .\add-credentials.ps1 -Name ZHIPU_API_KEY

.EXAMPLE
  .\add-credentials.ps1 -Name DEEPSEEK_API_KEY -FromFile C:\temp\key.txt

.EXAMPLE
  .\add-credentials.ps1 -Name ALIBABA_CLOUD_ACCESS_KEY_SECRET -Remove
#>
[CmdletBinding(DefaultParameterSetName = 'Prompt')]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Z][A-Z0-9_]*$')]
  [string]$Name,

  [Parameter(ParameterSetName = 'Value')]
  [string]$Value,

  [Parameter(ParameterSetName = 'File')]
  [string]$FromFile,

  [Parameter(ParameterSetName = 'Remove')]
  [switch]$Remove,

  [string]$DshHome
)

$ErrorActionPreference = 'Stop'

function Resolve-DshHome {
  param([string]$Explicit)
  if ($Explicit) { return $Explicit }
  if ($env:DSH_HOME) { return $env:DSH_HOME }
  return (Join-Path $HOME '.dsh')
}

function Read-SecretValue {
  $secure = Read-Host -AsSecureString "Paste the secret for $Name"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) | Out-Null
  }
}

function Quote-Yaml([string]$text) {
  # Single-quoted YAML scalar: keys never contain quotes, but escape defensively.
  return "'" + $text.Replace("'", "''") + "'"
}

$homeDir = Resolve-DshHome $DshHome
$store = Join-Path $homeDir '.credentials.yaml'

if (-not (Test-Path $store)) {
  New-Item -ItemType Directory -Path $homeDir -Force | Out-Null
  [IO.File]::WriteAllText($store, "version: 1`nrefs:`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "created $store"
}

$raw = [IO.File]::ReadAllText($store, [Text.Encoding]::UTF8)
$linePattern = "(?m)^[ \t]{2}" + [regex]::Escape($Name) + ":[^\r\n]*$"

if ($Remove) {
  if (-not [regex]::IsMatch($raw, $linePattern)) {
    Write-Host "$Name is not present; nothing to remove."
    return
  }
  $updated = [regex]::Replace($raw, $linePattern + "\r?\n?", '')
  [IO.File]::WriteAllText($store, $updated, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "removed $Name from $store"
  return
}

if ($PSCmdlet.ParameterSetName -eq 'File') {
  if (-not (Test-Path $FromFile)) { throw "file not found: $FromFile" }
  $secret = ([IO.File]::ReadAllText($FromFile, [Text.Encoding]::UTF8)).Trim()
  Remove-Item $FromFile -Force
  Write-Host "imported and deleted $FromFile"
} elseif ($PSCmdlet.ParameterSetName -eq 'Value') {
  $secret = $Value.Trim()
} else {
  $secret = (Read-SecretValue).Trim()
}

if ([string]::IsNullOrWhiteSpace($secret)) { throw 'the secret is empty; nothing written' }

$entry = "  ${Name}: " + (Quote-Yaml $secret)

if ([regex]::IsMatch($raw, $linePattern)) {
  $updated = [regex]::Replace($raw, $linePattern, { param($m) $entry })
} elseif ([regex]::IsMatch($raw, '(?m)^refs:\s*$')) {
  $updated = [regex]::Replace($raw, '(?m)^refs:\s*$', "refs:`n$entry", 1)
} else {
  $updated = $raw.TrimEnd() + "`nrefs:`n$entry`n"
}

[IO.File]::WriteAllText($store, $updated, (New-Object System.Text.UTF8Encoding($false)))

# Restrict the file to the current user: it holds every provider key.
try {
  & icacls $store /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
} catch {
  Write-Warning "could not tighten ACL on $store (non-fatal)"
}

$check = [IO.File]::ReadAllText($store, [Text.Encoding]::UTF8)
$stored = [regex]::Match($check, "(?m)^[ \t]{2}" + [regex]::Escape($Name) + ":\s*(.+)$")
if (-not $stored.Success) { throw "write failed: $Name not found after update" }

Write-Host ("stored {0} in {1} (length {2}, suffix {3})" -f `
  $Name, $store, $secret.Length, $secret.Substring([Math]::Max(0, $secret.Length - 4)))
Write-Host 'Restart DSH only if the provider list changed; credentials are re-read per request.'
