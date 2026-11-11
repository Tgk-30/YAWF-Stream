$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class YawfNativeSecurity {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileSecurityW(string name, uint information, [Out] byte[] buffer, uint length, out uint needed);
  public static byte[] Read(string path) {
    uint needed;
    bool initial = GetFileSecurityW(path, 5, null, 0, out needed);
    if (initial || Marshal.GetLastWin32Error() != 122 || needed < 20 || needed > 262144)
      throw new InvalidOperationException("Storage metadata could not be read.");
    byte[] bytes = new byte[(int)needed];
    uint actual;
    if (!GetFileSecurityW(path, 5, bytes, (uint)bytes.Length, out actual) || actual > bytes.Length)
      throw new InvalidOperationException("Storage metadata could not be read.");
    return bytes;
  }
}
'@
$entries = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$installer = $null
try { $installer = ([Security.Principal.NTAccount]::new('NT SERVICE', 'TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value } catch {}
$result = @()
foreach ($entry in $entries) {
  $attributes = [IO.File]::GetAttributes($entry.path)
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new([YawfNativeSecurity]::Read($entry.path), 0)
  $rules = @()
  $types = @()
  if ($null -ne $raw.DiscretionaryAcl) {
    foreach ($ace in $raw.DiscretionaryAcl) {
      $types += [int]$ace.AceType
      if ($ace -isnot [Security.AccessControl.CommonAce] -or [int]$ace.AceType -notin @(0, 1)) { continue }
      $aceFlags = [int]$ace.AceFlags
      $rules += [ordered]@{
        sid = $ace.SecurityIdentifier.Value
        allow = [int]$ace.AceType -eq 0
        rights = ([int64]$ace.AccessMask -band 4294967295)
        inheritOnly = ($aceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0
        objectInherit = ($aceFlags -band [int][Security.AccessControl.AceFlags]::ObjectInherit) -ne 0
        containerInherit = ($aceFlags -band [int][Security.AccessControl.AceFlags]::ContainerInherit) -ne 0
        noPropagate = ($aceFlags -band [int][Security.AccessControl.AceFlags]::NoPropagateInherit) -ne 0
      }
    }
  }
  $result += [ordered]@{
    id = $entry.id
    kind = $entry.kind
    currentSid = $current
    ownerSid = $raw.Owner.Value
    trustedInstallerSid = $installer
    directory = $attributes.HasFlag([IO.FileAttributes]::Directory)
    reparse = $attributes.HasFlag([IO.FileAttributes]::ReparsePoint)
    daclPresent = ($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0
    daclNull = $null -eq $raw.DiscretionaryAcl
    rawAceTypes = $types
    rules = $rules
  }
}
[Console]::WriteLine((ConvertTo-Json -InputObject $result -Depth 8 -Compress))
