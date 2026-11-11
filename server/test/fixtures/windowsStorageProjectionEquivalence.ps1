$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Web.Extensions
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $bytes = [IO.File]::ReadAllBytes($inputData.helper)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
  if ($hash -cne $inputData.sha256) { throw 'Helper binding mismatch.' }
  $assembly = [Reflection.Assembly]::Load($bytes)
  $type = $assembly.GetType('StorageDescriptorObserver', $true)
  $method = $type.GetMethod('Project', [Reflection.BindingFlags]'Static, NonPublic')
  if ($null -eq $method) { throw 'Projection unavailable.' }
  $current = 'S-1-5-21-123-456-789-1001'
  $owner = [Security.Principal.SecurityIdentifier]::new($current)
  $cases = 0
  foreach ($case in @('unsigned', 'ordered', 'unsupported-object', 'unsupported-callback', 'empty', 'null', 'absent', 'reparse')) {
    $acl = [Security.AccessControl.RawAcl]::new(2, 3)
    $flags = [Security.AccessControl.AceFlags]'ObjectInherit, ContainerInherit'
    if ($case -notin @('empty', 'null', 'absent')) {
      $acl.InsertAce($acl.Count, [Security.AccessControl.CommonAce]::new($flags, [Security.AccessControl.AceQualifier]::AccessAllowed, -1, $owner, $false, $null))
    }
    if ($case -eq 'ordered') {
      $acl.InsertAce($acl.Count, [Security.AccessControl.CommonAce]::new([Security.AccessControl.AceFlags]::None, [Security.AccessControl.AceQualifier]::AccessDenied, 1, $owner, $false, $null))
    }
    if ($case -eq 'unsupported-object') {
      $acl = [Security.AccessControl.RawAcl]::new(4, 1)
      $acl.InsertAce(0, [Security.AccessControl.ObjectAce]::new($flags, [Security.AccessControl.AceQualifier]::AccessAllowed, 1, $owner,
        [Security.AccessControl.ObjectAceFlags]::ObjectAceTypePresent, [Guid]::Empty, [Guid]::Empty, $false, $null))
    }
    if ($case -eq 'unsupported-callback') {
      $acl.InsertAce($acl.Count, [Security.AccessControl.CommonAce]::new($flags, [Security.AccessControl.AceQualifier]::AccessAllowed, 1, $owner, $true, [byte[]]@(0, 0, 0, 0)))
    }
    $control = [Security.AccessControl.ControlFlags]'SelfRelative, DiscretionaryAclPresent'
    if ($case -in @('null', 'absent')) { $acl = $null }
    if ($case -eq 'absent') { $control = [Security.AccessControl.ControlFlags]::SelfRelative }
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($control, $owner, $owner, $null, $acl)
    $binary = [byte[]]::new($raw.BinaryLength); $raw.GetBinaryForm($binary, 0)
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($binary, 0)
    $attributes = [IO.FileAttributes]::Directory
    if ($case -eq 'reparse') { $attributes = $attributes -bor [IO.FileAttributes]::ReparsePoint }
    $rules = @(); $types = @()
    if ($null -ne $raw.DiscretionaryAcl) {
      foreach ($ace in $raw.DiscretionaryAcl) {
        $types += [int]$ace.AceType
        if ($ace -isnot [Security.AccessControl.CommonAce] -or [int]$ace.AceType -notin @(0, 1)) { continue }
        $aceFlags = [int]$ace.AceFlags
        $rules += [ordered]@{
          sid = $ace.SecurityIdentifier.Value; allow = [int]$ace.AceType -eq 0
          rights = ([int64]$ace.AccessMask -band 4294967295)
          inheritOnly = ($aceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0
          objectInherit = ($aceFlags -band [int][Security.AccessControl.AceFlags]::ObjectInherit) -ne 0
          containerInherit = ($aceFlags -band [int][Security.AccessControl.AceFlags]::ContainerInherit) -ne 0
          noPropagate = ($aceFlags -band [int][Security.AccessControl.AceFlags]::NoPropagateInherit) -ne 0
        }
      }
    }
    $old = [ordered]@{ id = 0; kind = 'directory'; currentSid = $current; ownerSid = $raw.Owner.Value; trustedInstallerSid = $null
      directory = $true; reparse = $attributes.HasFlag([IO.FileAttributes]::ReparsePoint)
      daclPresent = ($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0
      daclNull = $null -eq $raw.DiscretionaryAcl; rawAceTypes = $types; rules = $rules }
    $new = $method.Invoke($null, [object[]]@($binary, $attributes, $current, $null, 0, 'directory'))
    # Comparison stays in memory. A failure never prints either descriptor.
    $serializer = [Web.Script.Serialization.JavaScriptSerializer]::new()
    $oldJson = ConvertTo-Json -InputObject $old -Depth 8 -Compress
    $newJson = $serializer.Serialize($new)
    if ($oldJson -cne $newJson) { throw 'Projection differs.' }
    $cases++
  }
  [Console]::WriteLine('{"equivalent":true,"cases":8}')
} catch {
  [Console]::Error.WriteLine('Native descriptor projection equivalence failed. Raw observations were not retained.')
  exit 1
}
