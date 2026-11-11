# Windows storage descriptor observer

The server performs a fresh read-only descriptor observation for each storage
admission. It does not compile code at runtime or cache privacy approvals.

## Explicit Windows producer preparation

The producer requires the existing in-box compiler at
`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` and the actual
.NET Framework 4.8 reference assemblies at
`C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8`.
Missing prerequisites fail closed. Nothing is downloaded or installed.

From the repository root:

1. Run `node scripts/prepare_windows_storage_observer.mjs compile` once.
2. Have the release owner sign
   `server/.build/windows-storage-observer/unsigned/StorageDescriptorObserver.exe`.
   Signing is a separate owner-controlled operation, not implemented here.
3. Independently hash the final executable, then run
   `node scripts/prepare_windows_storage_observer.mjs bind --sha256 <final-sha256>`.
4. Run `cd server && npm run build`, then the ordinary resource preparation.

Unsigned development or native-test evidence uses the same explicit bind step
with the independently pinned unsigned hash. Binding does not claim signing.
Compile and bind refuse existing outputs rather than replacing signed bytes.
The ignored preparation directory must be intentionally removed by its owner
before a genuinely new producer operation. Ordinary server builds never compile.

The metadata records source, protocol, compiler, reference-assembly and executable
hashes, without local paths, SIDs or native output. Production CommonJS embeds its
expected binding. Editing a runtime manifest cannot authorize another executable.
Only the executable and binding JSON may occupy its dedicated runtime directory;
configuration files, DLLs, subdirectories and reparse indirection are refused.

## Development and cold native QA

Windows source execution and direct Vitest require the prepared runtime directory
at `server/.build/windows-storage-observer/runtime`. Non-Windows imports, tests and
builds do not require a compiler or generated module. Packaged resolution is beside
the server bundle, not beside Node, so relocating Node for smoke checks is safe.

Cold consumers receive the exact producer preparation artifact. Hash admission
must not execute the helper, compiler or a version probe before the first timed
storage admission. Native old/new descriptor equivalence runs afterward, keeps
raw descriptors only in memory and reports scalar comparisons. Each helper call
retains the 7000 ms timeout and 256000-byte output bound. Timing improvements and
Windows compatibility require separate native qualification.
