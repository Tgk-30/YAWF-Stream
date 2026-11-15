# Isolated foreground playback QA policy

This directory's seccomp base is the unmodified official
[Playwright 1.65.1 profile](https://github.com/microsoft/playwright/blob/v1.65.1/utils/docker/seccomp_profile.json).
`LICENSE.playwright` is the accompanying
[Apache-2.0 license](https://github.com/microsoft/playwright/blob/v1.65.1/LICENSE).

The new test-only profile version is **playwright-1.65.1-chroot-v1**. It is not
the unchanged upstream policy. Canonical two-space JSON preserves every original
policy value and rule, then appends exactly this unconditional rule:

```json
{"names":["chroot"],"action":"SCMP_ACT_ALLOW","args":[]}
```

The original capability-gated `chroot` rule remains intact. With Docker's
`--cap-drop ALL`, that original rule is filtered out before Chromium creates its
own nested user namespace. The public browser control observed a failing
`sys_chroot("/proc/self/fdinfo/")` check under that policy. This derivation permits
that syscall through seccomp, but grants no parent-process capability.
[chroot(2)](https://man7.org/linux/man-pages/man2/chroot.2.html) still requires
`CAP_SYS_CHROOT` in the caller's user namespace. Capabilities in a newly created
[user namespace](https://man7.org/linux/man-pages/man7/user_namespaces.7.html)
do not grant capabilities in its parent. A post-exec chroot probe is not a
substitute for Chromium's actual forked sandbox path.

Pinned SHA-256 values:

- Official base: `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`
- License: `45873d00a0dd243596deb4aa23b2493b3d1f0671921bf2538ea431d7380220eb`
- Derived profile: `e53c15d248f57bceec0a3a16fad1b4ab0d05a7bddb455f86a60e2dba5612cdf7`

`node scripts/prepare_foreground_seccomp.mjs` accepts no policy or path flags.
It verifies the bounded vendored inputs, exact semantic delta and output hash,
then atomically publishes a new mode-0600 profile inside owned `RUNNER_TEMP`.
An existing output, including a symlink, is never overwritten.

Only the explicitly isolated workflow uses this derived policy: host22,
`--network none`, nonroot, all capabilities dropped, no-new-privileges,
read-only root filesystem and the existing resource limits. All five parent
capability masks must be zero and `NoNewPrivs` must be one before any browser or
fixture. Chromium sandboxing stays enabled. No added capability, unconfined
profile, sysctl change or sandbox-disabling flag is permitted.

This is a new test-policy candidate awaiting qualification, not evidence of playback
success or a fix for periodic pauses. It still requires the actual sandboxed
public browser control, admission, both 480-second playback cases and forced
stall control. Do not reuse this profile for production or unrelated workloads.
