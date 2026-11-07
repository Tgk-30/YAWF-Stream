param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [ValidateSet('inspect', 'private-test-parent', 'permissive-test-parent')][string]$Mode = 'inspect'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$inputData = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8 | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($inputData.root)
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $root.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or
    -not ([IO.Path]::GetFileName($root)).StartsWith('yawf-win-storage-audit-') -or
    (Get-Item -LiteralPath $root).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
  throw 'Only a fresh owned temporary audit directory is admitted.'
}
if ((Get-Content -LiteralPath (Join-Path $root '.audit-owner') -Raw) -ne 'YAWF disposable storage audit') {
  throw 'Missing disposable fixture ownership marker.'
}
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow

function Admitted-Path([string]$path) {
  $full = [IO.Path]::GetFullPath($path)
  if (-not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or
      (Get-Item -LiteralPath $full).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
    throw 'Audit path escaped its disposable fixture.'
  }
  return $full
}

if ($Mode -ne 'inspect') {
  $path = Admitted-Path $inputData.path
  if (-not (Get-Item -LiteralPath $path).PSIsContainer -or
      @(Get-ChildItem -LiteralPath $path -Force).Count -ne 0) {
    throw 'Fixture ACL setup requires an empty owned directory.'
  }
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($current)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($current, $system, $administrators)) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $propagation, $allow))
  }
  if ($Mode -eq 'permissive-test-parent') {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $everyone, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inherit, $propagation, $allow))
  }
  Set-Acl -LiteralPath $path -AclObject $acl
  [Console]::WriteLine('{"configuredDisposableParent":true}')
  exit 0
}

$results = @()
foreach ($entry in $inputData.files) {
  $path = Admitted-Path $entry.path
  $acl = Get-Acl -LiteralPath $path
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  $present = ($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0
  $rules = @()
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    $sid = $rule.IdentityReference.Value
    $kind = if ($sid -eq $current.Value) { 'current-user' }
      elseif ($sid -eq $system.Value) { 'system' }
      elseif ($sid -eq $administrators.Value) { 'administrators' }
      elseif ($sid -eq $everyone.Value) { 'everyone' }
      else { 'other' }
    $rules += [ordered]@{
      principal = $kind
      allow = $rule.AccessControlType -eq $allow
      rights = [int64]$rule.FileSystemRights
      inherited = $rule.IsInherited
      inheritOnly = ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
    }
  }
  $unexpected = @($rules | Where-Object {
    $_.allow -and -not $_.inheritOnly -and $_.rights -ne 0 -and
      $_.principal -notin @('current-user', 'system', 'administrators')
  })
  $ownerAdmitted = $owner -in @($current.Value, $system.Value, $administrators.Value)
  $results += [ordered]@{
    artifact = $entry.artifact
    observerPowerShellVersion = $PSVersionTable.PSVersion.ToString()
    daclPresent = $present
    daclNull = $null -eq $raw.DiscretionaryAcl
    ownerAdmitted = $ownerAdmitted
    inheritanceProtected = $acl.AreAccessRulesProtected
    unexpectedAllowCount = $unexpected.Count
    rules = $rules
    structurallyPrivate = $present -and ($null -ne $raw.DiscretionaryAcl) -and
      $ownerAdmitted -and $unexpected.Count -eq 0
  }
}
[Console]::WriteLine((ConvertTo-Json -InputObject $results -Depth 8 -Compress))
