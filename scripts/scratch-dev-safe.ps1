<#
.SYNOPSIS
  A dev server on a SCRATCH schema with every side channel disarmed, for the
  HTTP acceptance harnesses. Never the live tables, never real mail or Pusher.
.DESCRIPTION
  Wraps scripts\scratch.ps1 -Push and -Dev. What it adds:

    * Refuses while anything listens on port 3000. Next 16 allows one
      `next dev` per directory (the lock is .next/dev), and the scratch server
      shares .next/dev with the live one, so the live server must be stopped.
      Restart it afterwards with `npm run dev:clean`.
    * Refuses any -Name but scratch_[a-z0-9_]+ (so never "public").
    * Disarms the environment for THIS PROCESS ONLY; every value is restored
      when the server stops (Ctrl+C), so the shell is left as it was.

  The harness side of a run is scripts\run-auth-harnesses.ps1.

.EXAMPLE
  .\scripts\scratch-dev-safe.ps1 -Name scratch_auth -Port 3001
.EXAMPLE
  # After a restart the harness runner asked for: the schema is already pushed
  .\scripts\scratch-dev-safe.ps1 -Name scratch_auth -Port 3001 -NoPush
.EXAMPLE
  # Pusher with NO secret at all: trigger() throws synchronously instead of
  # rejecting. scripts/verify-pusher-safe.ts runs once in each mode.
  .\scripts\scratch-dev-safe.ps1 -Name scratch_pusher -Port 3001 -PusherSecret unset
#>
param(
  [Parameter(Mandatory = $true)] [string] $Name,
  [int]    $Port = 3001,
  [switch] $NoPush,
  # "invalid-scratch" (the default): every server-side trigger is REJECTED by
  # Pusher. "unset": the secret is missing, so trigger() THROWS before it
  # returns a promise. Both must leave every response unchanged; see
  # src/lib/realtime.ts. "real": the .env secret is left alone, for the one
  # harness check that needs delivery to work (verify-meetup-both-sides, test
  # 8). Opt-in only, and only after checking the scratch schema holds no copy
  # of a live user: events go to private-user-<id> channels of scratch rows.
  # Every OTHER disarm below still applies.
  [ValidateSet("invalid-scratch", "unset", "real")] [string] $PusherSecret = "invalid-scratch",
  [string] $ProjectDir = "D:\BAYLO\baylo"
)

$ErrorActionPreference = "Stop"
function Refuse([string] $why) { Write-Host "`n  REFUSING: $why`n" -ForegroundColor Red; exit 1 }

# ── Target ──────────────────────────────────────────────────────────────────
if ($Name -eq "public" -or $Name -notmatch '^scratch_[a-z0-9_]+$') {
  Refuse "-Name must match scratch_[a-z0-9_]+ (got '$Name'). 'public' is the live database."
}
if ($Port -eq 3000) { Refuse "-Port 3000 is the live server's port. Use 3001." }

# ── Nothing live may be running ─────────────────────────────────────────────
# @(...) because one match comes back as a bare object, not a one-item array.
$live = @(Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue)
if ($live.Count -gt 0) {
  $owners = ($live | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; "$($_.OwningProcess) ($($p.ProcessName))" }) -join ", "
  Refuse "something is listening on port 3000 (PID $owners). Stop your live server first (Ctrl+C in its terminal)."
}
$taken = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
if ($taken.Count -gt 0) { Refuse "port $Port is already in use (PID $($taken[0].OwningProcess))." }
# A `next dev` from this project on some other port holds the same .next/dev lock.
$nextDev = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'BAYLO\\baylo\\node_modules\\.*next' -and $_.CommandLine -match '\bdev\b' })
if ($nextDev.Count -gt 0) {
  Refuse "a next dev from D:\BAYLO\baylo is still running (PID $(($nextDev | ForEach-Object ProcessId) -join ', ')). Stop it first."
}
# Next loads these too; the pool URL must not come back from any of them.
foreach ($f in ".env", ".env.local", ".env.development", ".env.development.local") {
  $path = Join-Path $ProjectDir $f
  if ((Test-Path $path) -and (Select-String -Path $path -Pattern '^\s*DATABASE_POOL_URL\s*=' -Quiet)) {
    Refuse "$f defines DATABASE_POOL_URL (the live pooler). next dev would load it; remove or comment it out first."
  }
}

# ── Disarmed environment, this process only ─────────────────────────────────
# Every value here is fake. An empty value leaves the variable DEFINED but
# empty (measured 11 Oct 2026: .NET's SetEnvironmentVariable(k, "") does not
# delete it here), which the app's truthiness checks read as unset AND which
# stops Next refilling it from a .env file. For the pooler that is the safer
# of the two; the check above also refuses any .env that defines it.
$fake = [ordered]@{
  DATABASE_POOL_URL     = ""                                # the live transaction pooler: never
  # "" would leave an EMPTY secret, which signs (an empty HMAC key is valid)
  # and so never throws. "unset" travels as a sentinel that src/lib/pusher.ts
  # maps to a genuinely missing secret, which does.
  PUSHER_SECRET         = $(if ($PusherSecret -eq "unset") { "__unset__" } else { "invalid-scratch" })  # server-side triggers fail; nothing reaches phones
  EMAIL_SMTP_HOST       = "127.0.0.1"                       # the harnesses' own SMTP sink...
  EMAIL_SMTP_PORT       = "2525"                            # ...which they open on this port
  EMAIL_SMTP_USER       = "scratch-user"                    # the sink accepts any AUTH
  EMAIL_SMTP_PASS       = "scratch-pass"
  NEXTAUTH_URL          = "http://localhost:$Port"
  AUTH_TRUST_HOST       = "true"
  # Beyond the brief, same reason: nothing a harness does should reach a paid
  # or third-party service. None of the auth harnesses upload or call Claude.
  CLOUDINARY_API_SECRET = "invalid-scratch"
  ANTHROPIC_API_KEY     = "invalid-scratch"
  # Unset, so every request's rate-limit key is "direct-client", as the
  # harnesses' budget arithmetic assumes.
  TRUST_PROXY           = ""
}
# "real": PUSHER_SECRET is DELETED (below, after the loop), so Next reads it
# from .env. Not left alone: a value the window exported would reach the
# server, and Next never overrides a variable that is already set. Not "" and
# not $null: PowerShell passes $null to a .NET string parameter as "", and ""
# leaves the variable defined and EMPTY. The first version of this option did
# exactly that -- measured 11 Oct 2026, the server signed channel auth with an
# empty secret and every real subscription failed. [NullString]::Value is the
# one value that reaches .NET as null, which deletes. It stays in $fake so it
# is saved and restored like every other key.
$saved = @{}
foreach ($k in @($fake.Keys) + "DATABASE_URL") { $saved[$k] = [Environment]::GetEnvironmentVariable($k, "Process") }

try {
  foreach ($k in $fake.Keys) { [Environment]::SetEnvironmentVariable($k, $fake[$k], "Process") }
  if ($PusherSecret -eq "real") {
    [Environment]::SetEnvironmentVariable("PUSHER_SECRET", [NullString]::Value, "Process")
    if ([Environment]::GetEnvironmentVariables("Process").Contains("PUSHER_SECRET")) { Refuse "could not delete PUSHER_SECRET for -PusherSecret real." }
  }
  if ([Environment]::GetEnvironmentVariable("DATABASE_POOL_URL", "Process")) { Refuse "could not clear DATABASE_POOL_URL." }

  Write-Host ""
  Write-Host "  scratch-dev-safe" -ForegroundColor Cyan
  Write-Host "  target schema : $Name   (DATABASE_URL = .env base + ?schema=$Name, set by scratch.ps1)"
  Write-Host "  port          : $Port"
  foreach ($k in $fake.Keys) {
    if ($k -eq "PUSHER_SECRET" -and $PusherSecret -eq "real") { continue }  # shown below
    $v = [Environment]::GetEnvironmentVariable($k, "Process")
    Write-Host ("  {0,-21} : {1}" -f $k, $(if ($v) { $v } else { "<cleared>" }))
  }
  if ($PusherSecret -eq "real") {
    Write-Host ("  {0,-21} : {1}" -f "PUSHER_SECRET", "REAL (cleared here; Next reads .env) -- events are delivered") -ForegroundColor Yellow
    if ($saved["PUSHER_SECRET"]) {
      Write-Host ("  {0,-21} : {1}" -f "", "note: this window had PUSHER_SECRET set (length $($saved["PUSHER_SECRET"].Length)); it is restored on exit") -ForegroundColor Yellow
    }
  }
  Write-Host ""

  if (-not $NoPush) {
    & (Join-Path $ProjectDir "scripts\scratch.ps1") -Push -Name $Name -ProjectDir $ProjectDir
    if ($LASTEXITCODE -ne 0) { Refuse "scratch.ps1 -Push failed." }
  }
  # Blocks until Ctrl+C. The finally below still runs.
  & (Join-Path $ProjectDir "scripts\scratch.ps1") -Dev -Name $Name -Port $Port -ProjectDir $ProjectDir
} finally {
  # A key the window did not have is DELETED, not restored as "": PowerShell
  # passes $null to .NET as "", which left every such key defined and empty --
  # and a live `npm run dev:clean` from this window then ran with an empty
  # Pusher secret, Cloudinary secret, SMTP host and NEXTAUTH_URL (found 11 Oct
  # 2026). [NullString]::Value is the one value that reaches .NET as null.
  foreach ($k in $saved.Keys) {
    $v = if ($null -eq $saved[$k]) { [NullString]::Value } else { $saved[$k] }
    [Environment]::SetEnvironmentVariable($k, $v, "Process")
  }
  Write-Host "`n  environment restored. Schema $Name is KEPT -- drop it with: .\scripts\scratch.ps1 -Drop -Name $Name"
  Write-Host "  restart your live server with: npm run dev:clean`n"
}
