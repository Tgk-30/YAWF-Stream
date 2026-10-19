package com.yawf.runtimeinstrumentation;

import java.util.LinkedHashMap;
import java.util.Map;

public final class FlowPolicySelfTest {
    private FlowPolicySelfTest() {}

    public static void main(String[] args) {
        Map<String, Runnable> tests = new LinkedHashMap<>();
        tests.put("firstRunPriority", FlowPolicyAssertions::firstRunWinsWhenBothWebClassifiersMatch);
        tests.put("tierComplete", FlowPolicyAssertions::tierRequiresCompleteControls);
        tests.put("consentPriority", FlowPolicyAssertions::nativeConsentWinsWhenVisible);
        tests.put("nativeButtonCase", FlowPolicyAssertions::nativeButtonLabelsAcceptUppercaseAndMixedCase);
        tests.put("nativeButtonAnchoring", FlowPolicyAssertions::nativeButtonLabelsRejectAffixesAndNewlines);
        tests.put("nativeButtonResource", FlowPolicyAssertions::nativeButtonResourceIdentityIsExact);
        tests.put("termsPolicy", FlowPolicyAssertions::bindingTermsAreRejectedButPrivacyNoticeIsAllowed);
        tests.put("exactNativeResult", FlowPolicyAssertions::nativeResultRequiresExactTitleAndMessage);
        tests.put("versionPins", FlowPolicyAssertions::channelVersionsArePinned);

        if (args.length == 1) {
            Runnable selected = tests.get(args[0]);
            if (selected == null) {
                throw new IllegalArgumentException("Unknown self-test: " + args[0]);
            }
            selected.run();
            System.out.println("PASS " + args[0]);
            return;
        }
        if (args.length != 0) {
            throw new IllegalArgumentException("Expected zero args or one test name");
        }
        tests.forEach((name, test) -> {
            test.run();
            System.out.println("PASS " + name);
        });
        System.out.println("PASS all=" + tests.size());
    }
}
