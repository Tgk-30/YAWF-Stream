using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

[assembly: AssemblyTitle("YAWF Windows storage descriptor observer")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: TargetFramework(".NETFramework,Version=v4.8")]

internal static class YawfNativeSecurity {
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

internal static class StorageDescriptorObserver {
  internal const string Protocol = "yawf-windows-storage-descriptor-v1";

  private static void Require(bool condition) {
    if (!condition) throw new InvalidOperationException("Invalid storage observation request.");
  }

  internal static Dictionary<string, object> Project(byte[] bytes, FileAttributes attributes,
      string current, string installer, int id, string kind) {
    RawSecurityDescriptor raw = new RawSecurityDescriptor(bytes, 0);
    List<object> rules = new List<object>();
    List<int> types = new List<int>();
    if (raw.DiscretionaryAcl != null) {
      foreach (GenericAce generic in raw.DiscretionaryAcl) {
        int type = (int)generic.AceType;
        types.Add(type);
        CommonAce ace = generic as CommonAce;
        if (ace == null || (type != 0 && type != 1)) continue;
        AceFlags flags = ace.AceFlags;
        rules.Add(new Dictionary<string, object> {
          { "sid", ace.SecurityIdentifier.Value }, { "allow", type == 0 },
          { "rights", unchecked((uint)ace.AccessMask) },
          { "inheritOnly", (flags & AceFlags.InheritOnly) != 0 },
          { "objectInherit", (flags & AceFlags.ObjectInherit) != 0 },
          { "containerInherit", (flags & AceFlags.ContainerInherit) != 0 },
          { "noPropagate", (flags & AceFlags.NoPropagateInherit) != 0 }
        });
      }
    }
    return new Dictionary<string, object> {
      { "id", id }, { "kind", kind }, { "currentSid", current }, { "ownerSid", raw.Owner.Value },
      { "trustedInstallerSid", installer },
      { "directory", (attributes & FileAttributes.Directory) != 0 },
      { "reparse", (attributes & FileAttributes.ReparsePoint) != 0 },
      { "daclPresent", (raw.ControlFlags & ControlFlags.DiscretionaryAclPresent) != 0 },
      { "daclNull", raw.DiscretionaryAcl == null }, { "rawAceTypes", types }, { "rules", rules }
    };
  }

  private static int Main(string[] args) {
    try {
      Require(args.Length == 0);
      Console.InputEncoding = new UTF8Encoding(false, true);
      Console.OutputEncoding = new UTF8Encoding(false, true);
      JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue, RecursionLimit = 16 };
      Dictionary<string, object> request = json.DeserializeObject(Console.In.ReadToEnd()) as Dictionary<string, object>;
      Require(request != null && request.Count == 2 && request.ContainsKey("protocol") && request.ContainsKey("entries"));
      Require(request["protocol"] as string == Protocol);
      object[] entries = request["entries"] as object[];
      Require(entries != null && entries.Length > 0);
      string current = WindowsIdentity.GetCurrent().User.Value;
      string installer = null;
      try { installer = ((SecurityIdentifier)new NTAccount("NT SERVICE", "TrustedInstaller").Translate(typeof(SecurityIdentifier))).Value; } catch { }
      List<object> result = new List<object>();
      for (int id = 0; id < entries.Length; id++) {
        Dictionary<string, object> entry = entries[id] as Dictionary<string, object>;
        Require(entry != null && entry.Count == 3 && entry.ContainsKey("id") && entry.ContainsKey("path") && entry.ContainsKey("kind"));
        Require(entry["id"] is int && (int)entry["id"] == id);
        string path = entry["path"] as string;
        string kind = entry["kind"] as string;
        Require(path != null && path.Length > 0 && path.Length <= 4096 && path.IndexOf('\0') < 0);
        Require(kind == "file" || kind == "directory" || kind == "ancestor");
        FileAttributes attributes = File.GetAttributes(path);
        result.Add(Project(YawfNativeSecurity.Read(path), attributes, current, installer, id, kind));
      }
      string output = json.Serialize(new Dictionary<string, object> { { "protocol", Protocol }, { "descriptors", result } });
      Require(Encoding.UTF8.GetByteCount(output) + 1 <= 256000);
      Console.WriteLine(output);
      return 0;
    } catch {
      Console.Error.WriteLine("Storage metadata could not be read.");
      return 1;
    }
  }
}
