//! Eligibility for final Android Activity exit, excluding framework restarts.

#[derive(Default)]
pub(crate) struct NormalExitPolicy {
    normal_exit_requested: bool,
}

impl NormalExitPolicy {
    pub(crate) fn exit_requested(&mut self, code: Option<i32>) {
        // Record the latest accepted request. Android AppHandle::exit codes
        // finish the Activity, rather than choose the final process status.
        match code {
            Some(tauri::RESTART_EXIT_CODE) => self.exit_prevented(),
            _ => self.normal_exit_requested = true,
        }
    }

    pub(crate) fn exit_prevented(&mut self) {
        // Future api.prevent_exit() callers MUST also disarm this policy:
        // Tauri exposes no flag that lets us observe another handler's veto.
        self.normal_exit_requested = false;
    }

    pub(crate) fn take_normal_exit(&mut self) -> bool {
        std::mem::take(&mut self.normal_exit_requested)
    }
}

#[cfg(all(target_os = "android", feature = "android-lifecycle-probe"))]
pub(crate) fn lifecycle_probe(format: &'static std::ffi::CStr, value: libc::c_int) {
    #[link(name = "log")]
    unsafe extern "C" {
        fn __android_log_print(
            priority: libc::c_int,
            tag: *const libc::c_char,
            format: *const libc::c_char,
            ...
        ) -> libc::c_int;
    }
    // Private, default-disabled probe. No user data or persistent output.
    unsafe {
        __android_log_print(
            4,
            c"DSNormalExitProbe".as_ptr(),
            format.as_ptr(),
            libc::getpid(),
            value,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::NormalExitPolicy;

    #[test]
    fn initial_state_without_a_request_is_disarmed() {
        assert!(!NormalExitPolicy::default().take_normal_exit());
    }

    #[test]
    fn last_window_none_request_arms_normal_exit() {
        let mut policy = NormalExitPolicy::default();
        policy.exit_requested(None);
        assert!(policy.take_normal_exit());
    }

    #[test]
    fn programmatic_zero_request_arms_normal_exit() {
        let mut policy = NormalExitPolicy::default();
        policy.exit_requested(Some(0));
        assert!(policy.take_normal_exit());
    }

    #[test]
    fn programmatic_nonzero_request_arms_normal_exit() {
        let mut policy = NormalExitPolicy::default();
        policy.exit_requested(Some(23));
        assert!(policy.take_normal_exit());
    }

    #[test]
    fn negative_programmatic_requests_arm_normal_exit() {
        for code in [-1, -23] {
            let mut policy = NormalExitPolicy::default();
            policy.exit_requested(Some(code));
            assert!(policy.take_normal_exit(), "code={code}");
        }
    }

    #[test]
    fn minimum_programmatic_code_arms_normal_exit() {
        let mut policy = NormalExitPolicy::default();
        policy.exit_requested(Some(i32::MIN));
        assert!(policy.take_normal_exit());
    }

    #[test]
    fn maximum_nonrestart_code_arms_normal_exit() {
        let mut policy = NormalExitPolicy::default();
        policy.exit_requested(Some(tauri::RESTART_EXIT_CODE - 1));
        assert!(policy.take_normal_exit());
    }

    #[test]
    fn restart_request_remains_framework_owned() {
        let mut policy = NormalExitPolicy::default();
        policy.exit_requested(Some(tauri::RESTART_EXIT_CODE));
        assert!(!policy.take_normal_exit());
    }

    #[test]
    fn a_later_programmatic_request_keeps_an_earlier_none_eligible() {
        for code in [0, 23, -1, i32::MIN] {
            let mut policy = NormalExitPolicy::default();
            policy.exit_requested(None);
            policy.exit_requested(Some(code));
            assert!(policy.take_normal_exit(), "code={code}");
        }
    }

    #[test]
    fn a_later_none_request_arms_after_a_programmatic_request() {
        for code in [0, 23, -1, i32::MIN, tauri::RESTART_EXIT_CODE] {
            let mut policy = NormalExitPolicy::default();
            policy.exit_requested(Some(code));
            policy.exit_requested(None);
            assert!(policy.take_normal_exit(), "code={code}");
        }
    }

    #[test]
    fn a_later_restart_disarms_an_earlier_none_request() {
        let mut policy = NormalExitPolicy::default();
        policy.exit_requested(None);
        policy.exit_requested(Some(tauri::RESTART_EXIT_CODE));
        assert!(!policy.take_normal_exit());
    }

    #[test]
    fn a_later_restart_disarms_an_earlier_programmatic_request() {
        for code in [0, 23, -1, i32::MIN] {
            let mut policy = NormalExitPolicy::default();
            policy.exit_requested(Some(code));
            policy.exit_requested(Some(tauri::RESTART_EXIT_CODE));
            assert!(!policy.take_normal_exit(), "code={code}");
        }
    }

    #[test]
    fn a_later_programmatic_request_rearms_after_a_restart_request() {
        for code in [0, 23, -1, i32::MIN] {
            let mut policy = NormalExitPolicy::default();
            policy.exit_requested(Some(tauri::RESTART_EXIT_CODE));
            policy.exit_requested(Some(code));
            assert!(policy.take_normal_exit(), "code={code}");
        }
    }

    #[test]
    fn preventing_a_none_request_disarms_normal_exit() {
        let mut policy = NormalExitPolicy::default();
        policy.exit_requested(None);
        policy.exit_prevented();
        assert!(!policy.take_normal_exit());
    }

    #[test]
    fn preventing_a_programmatic_request_disarms_normal_exit() {
        for code in [0, 23, -1, i32::MIN] {
            let mut policy = NormalExitPolicy::default();
            policy.exit_requested(Some(code));
            policy.exit_prevented();
            assert!(!policy.take_normal_exit(), "code={code}");
        }
    }

    #[test]
    fn a_later_none_request_rearms_after_prevention() {
        let mut policy = NormalExitPolicy::default();
        policy.exit_requested(None);
        policy.exit_prevented();
        assert!(!policy.take_normal_exit());
        policy.exit_requested(None);
        assert!(policy.take_normal_exit());
    }

    #[test]
    fn a_later_programmatic_request_rearms_after_prevention() {
        let mut policy = NormalExitPolicy::default();
        policy.exit_requested(None);
        policy.exit_prevented();
        assert!(!policy.take_normal_exit());
        policy.exit_requested(Some(23));
        assert!(policy.take_normal_exit());
    }

    #[test]
    fn accepted_exit_eligibility_is_consumed_exactly_once() {
        for code in [None, Some(0), Some(23), Some(-1), Some(i32::MIN)] {
            let mut policy = NormalExitPolicy::default();
            policy.exit_requested(code);
            assert!(policy.take_normal_exit(), "code={code:?}");
            assert!(!policy.take_normal_exit(), "code={code:?}");
            assert!(!policy.take_normal_exit(), "code={code:?}");
        }
    }
}
