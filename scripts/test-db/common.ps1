<#
  What the scripts that reach a Supabase database share: reading a
  connection string and its password, signing in once before doing anything,
  and refusing to go on when a step fails. Dot-sourced, not run.

  $liveProjectRef is the live project, read from the environment rather than
  kept here. A script that writes asks Assert-NotLive first, so nothing meant
  for the test copy can be pointed at live by pasting the wrong string, and
  refuses outright when the live id is unknown.
#>

$postgresImage = "postgres:17"
# The live project's id, so Assert-NotLive can recognise it. Not in the repo:
# set PUKAGOLF_LIVE_PROJECT_REF in your environment, or put it in
# scripts/test-db/live-ref.local.txt (gitignored). With neither, the scripts
# that write refuse to run rather than risk pointing at live.
$liveProjectRef = $env:PUKAGOLF_LIVE_PROJECT_REF
if (-not $liveProjectRef) {
  $refFile = Join-Path $PSScriptRoot "live-ref.local.txt"
  if (Test-Path $refFile) { $liveProjectRef = (Get-Content $refFile -Raw).Trim() }
}

function Assert-DockerRunning {
  # Windows PowerShell turns a native command's redirected stderr into an error
  # under "Stop", so a stopped Docker would throw here instead of explaining.
  try { docker info *> $null } catch { }
  if ($LASTEXITCODE -ne 0) { throw "Docker isn't running. Start Docker Desktop, wait for it to say it's running, and try again." }
}

function Assert-NotLive([string]$ref) {
  if (-not $liveProjectRef) {
    throw "I don't know which project is live, so I can't promise this isn't it. Set PUKAGOLF_LIVE_PROJECT_REF or create scripts/test-db/live-ref.local.txt with the live project id. Nothing has been changed."
  }
  if ($ref -eq $liveProjectRef) {
    throw "That connection string is the LIVE project ($ref). This script only writes to the test copy. Nothing has been changed."
  }
}

function Read-Secret([string]$prompt) {
  $secure = Read-Host $prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# The project id, from a Session pooler connection string. The Direct one is
# refused here rather than at the first dump: its host only has an IPv6
# address, which Docker on Windows can't look up, and the error it gives
# ("could not translate host name") doesn't say which string to use instead.
function Get-ProjectRef([string]$url) {
  if ($url -match "@db\.[a-z0-9]{20}\.supabase\.co") {
    throw "That's the Direct connection string (it has db.<id>.supabase.co in it). Use the Session pooler one: Connect, Connection String, Session pooler. It has pooler.supabase.com in it."
  }
  if ($url -match "postgres\.([a-z0-9]{20})[:@]") { return $Matches[1] }
  throw "Couldn't find a project id in that connection string. Copy the Session pooler one again from the Connect button."
}

# A connection string, with the password asked for separately when it is
# pasted exactly as Supabase shows it. That keeps the password out of
# Notepad, and encoding it here means a password with @ or / in it can't
# break the string.
function Read-ConnectionString([string]$which, [string]$given) {
  $url = if ($given) { $given.Trim() } else { (Read-Host "$which database connection string (Session pooler)").Trim() }
  $ref = Get-ProjectRef $url
  if ($url -match "\[YOUR-PASSWORD\]") {
    $password = Read-Secret "$which database password"
    $url = $url.Replace("[YOUR-PASSWORD]", [Uri]::EscapeDataString($password))
  }
  return @{ Url = $url; Ref = $ref }
}

# Signs in once with a do-nothing query, before anything is dumped or loaded,
# so a wrong password is named as one rather than surfacing as "roles failed"
# halfway through. Supabase can block a computer for a while after repeated
# failed sign-ins, so the message says not to keep guessing.
function Test-Login([string]$which, [string]$url) {
  Write-Host "  $which password..."
  # Native stderr is collected here, which "Stop" would turn into an error.
  $ErrorActionPreference = "Continue"
  $output = docker run --rm $postgresImage psql --no-psqlrc --tuples-only --dbname $url --command "select 1" 2>&1
  if ($LASTEXITCODE -eq 0) { return }

  # Each line as plain text: Out-String would wrap long lines at the window's
  # width and could split the very words being looked for.
  $text = ($output | ForEach-Object { "$_" }) -join " "
  if ($text -match "password authentication failed") {
    throw "Supabase refused the $which password. Nothing has been read, copied or changed. Supabase can't show a password, only reset it: $which project, Project Settings, Database, Reset database password. Don't try more than once or twice in a row, or Supabase may block this computer for a while."
  }
  throw "Couldn't reach the $which database. Nothing has been read, copied or changed.`n$text"
}

function Invoke-Checked([string]$what, [scriptblock]$command) {
  Write-Host "  $what..."
  & $command
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE). Nothing after this step ran." }
}
