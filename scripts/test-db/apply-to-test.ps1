<#
  Apply migrations to the TEST project, never live, and optionally run tests
  against it afterwards.

      powershell -ExecutionPolicy Bypass -File <path to>\scripts\test-db\apply-to-test.ps1 `
        -TestUrl '<Session pooler string, [YOUR-PASSWORD] left in>' `
        -Migration <path to>\supabase\migrations\0045_clubs_and_leagues.sql `
        -Test <path to>\supabase\tests\club_isolation.sql

  Refuses the live project's connection string outright, checks the password
  before anything runs, and applies each migration as one transaction: a
  migration that fails, or whose own checks refuse, leaves the test project
  exactly as it was. Either -Migration or -Test may be left out.

  A test file manages its own transaction (club_isolation.sql rolls itself
  back), so it is run as written; it may include files from its own folder.

  Every migration is rehearsed first on a local copy
  (scripts/test-db/local-rehearsal.sh), so this is the second run, not the
  first.
#>
param(
  [string[]]$Migration = @(),
  [string[]]$Test = @(),
  [string]$TestUrl
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

if (-not $Migration -and -not $Test) { throw "Give -Migration, -Test, or both. Nothing has been changed." }

Assert-DockerRunning

function Get-Files([string[]]$paths) {
  # Run with powershell -File, "a.sql","b.sql" arrives as one comma-joined
  # string rather than a list.
  foreach ($path in ($paths -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    if (-not (Test-Path $path)) { throw "There's nothing at $path. Nothing has been changed." }
    Get-Item $path
  }
}
$migrationFiles = @(Get-Files $Migration)
$testFiles = @(Get-Files $Test)

$connection = Read-ConnectionString "TEST" $TestUrl
Assert-NotLive $connection.Ref

Write-Host ""
Write-Host "Test project: $($connection.Ref)"
foreach ($file in $migrationFiles) { Write-Host "  will apply $($file.Name)" }
foreach ($file in $testFiles) { Write-Host "  will run   $($file.Name)" }
$typed = Read-Host "Type the TEST project id to confirm"
if ($typed.Trim() -ne $connection.Ref) { throw "That isn't the test project id. Nothing has been changed." }

Write-Host ""
Write-Host "Checking the password"
Test-Login "TEST" $connection.Url

foreach ($file in $migrationFiles) {
  Write-Host ""
  # One transaction per migration, stopping at the first error, so a refusal
  # from the migration's own checks undoes everything that migration did.
  Invoke-Checked "applying $($file.Name)" {
    docker run --rm -v "$($file.DirectoryName):/migrations:ro" $postgresImage `
      psql --no-psqlrc --variable ON_ERROR_STOP=1 --single-transaction --quiet `
      --dbname $connection.Url --file "/migrations/$($file.Name)"
  }
}

foreach ($file in $testFiles) {
  Write-Host ""
  Invoke-Checked "running $($file.Name)" {
    docker run --rm -v "$($file.DirectoryName):/tests:ro" $postgresImage `
      psql --no-psqlrc --variable ON_ERROR_STOP=1 --quiet `
      --dbname $connection.Url --file "/tests/$($file.Name)"
  }
}

Write-Host ""
Write-Host "Done on $($connection.Ref)." -ForegroundColor Green
