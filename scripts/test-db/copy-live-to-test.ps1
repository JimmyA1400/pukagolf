<#
  Back up the live database, then load that copy into the test project.

  Live is only ever read: the three dumps and a row count. Everything that
  writes goes to the test project, and the script refuses to start if the two
  connection strings point at the same project.

  Needs Docker Desktop running (the dump and psql both run in containers, so
  nothing else has to be installed) and the two "Session pooler" connection
  strings, from each project's Connect button. Session pooler rather than
  Direct because Direct is IPv6-only and Docker on Windows usually isn't.

  Run it by its full path, from anywhere:

      powershell -ExecutionPolicy Bypass -File <path to>\scripts\test-db\copy-live-to-test.ps1

  Add -BackupOnly to take the backup of live and stop there. -LiveUrl and
  -TestUrl take the connection strings as Supabase shows them, with
  [YOUR-PASSWORD] left in, so only the passwords are typed at the prompts.
  -RestoreFrom <backup folder> loads an earlier backup into test without
  reading live again.

  The backup lands in Documents\PukaGolf backups\<date-time>\, outside every
  checkout: a worktree can be deleted along with whatever is in it, and no
  .gitignore can then stop a backup being committed from somewhere else. It
  holds every player's phone number and password hash: keep it on this
  computer.
#>
param(
  [switch]$BackupOnly,
  # A backup folder from an earlier run, loaded into test without reading live again.
  [string]$RestoreFrom,
  [string]$LiveUrl,
  [string]$TestUrl
)

$ErrorActionPreference = "Stop"

$here = $PSScriptRoot
$documents = [Environment]::GetFolderPath("MyDocuments")
$out = Join-Path $documents ("PukaGolf backups\" + (Get-Date -Format "yyyy-MM-dd_HHmm"))
$supabaseCli = "supabase@3.0.0"

. (Join-Path $PSScriptRoot "common.ps1")

# psql in a throwaway container, with the backup folder mounted at /work.
function Invoke-Psql([string]$url, [string[]]$arguments) {
  docker run --rm -v "${out}:/work" -v "${here}:/scripts:ro" $postgresImage `
    psql --no-psqlrc --variable ON_ERROR_STOP=1 --dbname $url @arguments
}

Assert-DockerRunning

if ($RestoreFrom) {
  if ($BackupOnly) { throw "-RestoreFrom loads an existing backup; -BackupOnly takes a new one. Use one or the other." }
  $out = (Resolve-Path $RestoreFrom).Path
  foreach ($file in "roles.sql", "schema.sql", "data.sql", "live-counts.txt") {
    if (-not (Test-Path (Join-Path $out $file))) { throw "$out has no $file, so it isn't a complete backup. Nothing has been touched." }
  }
  # The counts were taken from live with the dump, so the comparison at the
  # end still checks the copy against live as it was backed up.
  $liveRef = "backup in $out"
} else {
  $liveConnection = Read-ConnectionString "LIVE" $LiveUrl
  $live = $liveConnection.Url
  $liveRef = $liveConnection.Ref
}

if (-not $BackupOnly) {
  $testConnection = Read-ConnectionString "TEST" $TestUrl
  $test = $testConnection.Url
  $testRef = $testConnection.Ref
  Assert-NotLive $testRef
  if ($testRef -eq $liveRef) { throw "Both connection strings are the same project ($liveRef). Stopping: nothing has been touched." }

  Write-Host ""
  Write-Host "From: $liveRef   (read only)"
  Write-Host "Test: $testRef   (will be filled with the copy)"
  $typed = Read-Host "Type the TEST project id to confirm"
  if ($typed.Trim() -ne $testRef) { throw "That isn't the test project id. Stopping: nothing has been touched." }
}

Write-Host ""
Write-Host "Checking the passwords"
if (-not $RestoreFrom) { Test-Login "LIVE" $live }
if (-not $BackupOnly) { Test-Login "TEST" $test }

if (-not $RestoreFrom) {
  New-Item -ItemType Directory -Force $out | Out-Null
  Write-Host ""
  Write-Host "1. Backing up live into $out"
  Invoke-Checked "roles" { npx -y $supabaseCli db dump --remote="$live" -f "$out\roles.sql" --role-only }
  Invoke-Checked "schema" { npx -y $supabaseCli db dump --remote="$live" -f "$out\schema.sql" }
  Invoke-Checked "data" { npx -y $supabaseCli db dump --remote="$live" -f "$out\data.sql" --use-copy --data-only -x "storage.buckets_vectors" -x "storage.vector_indexes" }
  Invoke-Checked "row counts on live" { Invoke-Psql $live @("--tuples-only", "--no-align", "--file", "/scripts/row-counts.sql", "--output", "/work/live-counts.txt") }
}

if ($BackupOnly) {
  Write-Host ""
  Write-Host "Backup done: $out"
  exit 0
}

Write-Host ""
Write-Host "2. Loading the copy into test ($testRef)"
# Settings on Supabase's own supabase_* roles come across in the role dump,
# but only Supabase may change those roles, so the restore refuses them. A
# new project already has the same defaults; the lines are commented out of
# a copy, leaving the backup itself exactly as dumped.
# Written without a byte-order mark, which psql would read as part of the SQL.
$restoreRoles = (Get-Content "$out\roles.sql") -replace '^(ALTER ROLE "supabase_)', '-- $1'
[IO.File]::WriteAllLines("$out\roles-restore.sql", [string[]]$restoreRoles, (New-Object Text.UTF8Encoding $false))
# Supabase's file storage tables change shape between versions, and a newer
# test project may not have a table an older live one does. The app keeps no
# files there, so an empty storage table is left out of the copy; one with
# rows stops the run instead, so nothing is ever dropped without saying so.
$restoreData = New-Object System.Collections.Generic.List[string]
$storageTable = $null
$storageRows = 0
foreach ($line in [IO.File]::ReadAllLines("$out\data.sql")) {
  if ($storageTable) {
    if ($line -eq "\.") {
      if ($storageRows -gt 0) { throw "$storageTable has $storageRows rows in the backup, which this script won't leave out. Nothing has been touched." }
      $storageTable = $null
    } else {
      $storageRows++
    }
    continue
  }
  if ($line -match '^COPY ("storage"\."[^"]+")') {
    $storageTable = $Matches[1]
    $storageRows = 0
    continue
  }
  $restoreData.Add($line)
}
[IO.File]::WriteAllLines("$out\data-restore.sql", $restoreData, (New-Object Text.UTF8Encoding $false))

# One transaction: if any of it fails, the test project is left as it was.
Invoke-Checked "restore" { Invoke-Psql $test @("--single-transaction", "--file", "/work/roles-restore.sql", "--file", "/work/schema.sql", "--command", "SET session_replication_role = replica", "--file", "/work/data-restore.sql") }
Invoke-Checked "auth triggers and realtime" { Invoke-Psql $test @("--file", "/scripts/after-restore.sql") }

Write-Host ""
Write-Host "3. Comparing every table"
Invoke-Checked "row counts on test" { Invoke-Psql $test @("--tuples-only", "--no-align", "--file", "/scripts/row-counts.sql", "--output", "/work/test-counts.txt") }

$liveCounts = Get-Content "$out\live-counts.txt" | Where-Object { $_.Trim() }
$testCounts = Get-Content "$out\test-counts.txt" | Where-Object { $_.Trim() }
$diff = Compare-Object $liveCounts $testCounts

if ($diff) {
  Write-Host ""
  Write-Host "MISMATCH. These tables differ (<= live, => test):" -ForegroundColor Red
  $diff | Format-Table -AutoSize
  exit 1
}

Write-Host ""
Write-Host "Every table matches ($($liveCounts.Count) tables). Backup kept in $out" -ForegroundColor Green
