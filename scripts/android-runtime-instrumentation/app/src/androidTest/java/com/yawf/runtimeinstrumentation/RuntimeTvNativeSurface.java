package com.yawf.runtimeinstrumentation;

import java.util.regex.Pattern;

/** Admits only the exact native Media3 player surface shapes observed by the TV harness. */
final class RuntimeTvNativeSurface {
    private static final String PRODUCT_PACKAGE = "com.yawf.stream.tv";
    private static final String ROOT_CLASS = "android.widget.FrameLayout";
    private static final Pattern CONTROLS_DESCRIPTION =
            Pattern.compile("^(?:Show|Hide) player controls$");

    private RuntimeTvNativeSurface() { }

    static boolean admits(Candidate candidate) {
        boolean exactRoot = PRODUCT_PACKAGE.equals(candidate.rootPackage)
                && ROOT_CLASS.equals(candidate.rootClass)
                && candidate.rootClickable
                && candidate.rootEnabled
                && candidate.rootFocusable
                && candidate.rootVisible;
        boolean describedControls = candidate.description != null
                && CONTROLS_DESCRIPTION.matcher(candidate.description).matches();
        boolean emptyDescription = candidate.description == null
                || candidate.description.isEmpty();
        boolean visibleControllerState = candidate.controllerCount == 1
                && candidate.controllerVisible
                && candidate.playPauseCount == 1
                && candidate.playPauseClickable
                && candidate.playPauseEnabled
                && candidate.playPauseFocusable
                && candidate.playPauseVisible;
        boolean exactVideoContent = candidate.contentFrameCount == 1
                && candidate.contentFrameVisible
                && candidate.videoSurfaceCount == 1
                && candidate.videoSurfaceVisible;
        return exactRoot
                && (describedControls || (emptyDescription && visibleControllerState))
                && exactVideoContent;
    }

    static final class Candidate {
        final String rootPackage;
        final String rootClass;
        final String description;
        final boolean rootClickable;
        final boolean rootEnabled;
        final boolean rootFocusable;
        final boolean rootVisible;
        final int controllerCount;
        final boolean controllerVisible;
        final int playPauseCount;
        final boolean playPauseClickable;
        final boolean playPauseEnabled;
        final boolean playPauseFocusable;
        final boolean playPauseVisible;
        final int contentFrameCount;
        final boolean contentFrameVisible;
        final int videoSurfaceCount;
        final boolean videoSurfaceVisible;

        Candidate(
                String rootPackage,
                String rootClass,
                String description,
                boolean rootClickable,
                boolean rootEnabled,
                boolean rootFocusable,
                boolean rootVisible,
                int controllerCount,
                boolean controllerVisible,
                int playPauseCount,
                boolean playPauseClickable,
                boolean playPauseEnabled,
                boolean playPauseFocusable,
                boolean playPauseVisible,
                int contentFrameCount,
                boolean contentFrameVisible,
                int videoSurfaceCount,
                boolean videoSurfaceVisible) {
            this.rootPackage = rootPackage;
            this.rootClass = rootClass;
            this.description = description;
            this.rootClickable = rootClickable;
            this.rootEnabled = rootEnabled;
            this.rootFocusable = rootFocusable;
            this.rootVisible = rootVisible;
            this.controllerCount = controllerCount;
            this.controllerVisible = controllerVisible;
            this.playPauseCount = playPauseCount;
            this.playPauseClickable = playPauseClickable;
            this.playPauseEnabled = playPauseEnabled;
            this.playPauseFocusable = playPauseFocusable;
            this.playPauseVisible = playPauseVisible;
            this.contentFrameCount = contentFrameCount;
            this.contentFrameVisible = contentFrameVisible;
            this.videoSurfaceCount = videoSurfaceCount;
            this.videoSurfaceVisible = videoSurfaceVisible;
        }
    }
}
