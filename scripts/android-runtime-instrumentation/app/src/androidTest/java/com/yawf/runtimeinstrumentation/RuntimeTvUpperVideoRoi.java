package com.yawf.runtimeinstrumentation;

import java.util.List;

/** Validates the fixed unobscured video region used by the TV runtime harness. */
final class RuntimeTvUpperVideoRoi {
    static final int SCREEN_WIDTH = 1920;
    static final int SCREEN_HEIGHT = 1080;
    static final Bounds UPPER_VIDEO_ROI = new Bounds(480, 270, 1440, 405);

    private static final String PRODUCT_PACKAGE = "com.yawf.stream.tv";
    private static final String PLAYER_ROOT_CLASS = "android.widget.FrameLayout";
    private static final String CONTENT_FRAME_RESOURCE =
            PRODUCT_PACKAGE + ":id/exo_content_frame";
    private static final String CONTENT_FRAME_CLASS = "android.widget.FrameLayout";
    private static final String VIDEO_SURFACE_CLASS = "android.view.SurfaceView";
    private static final String CENTER_CONTROLS_RESOURCE =
            PRODUCT_PACKAGE + ":id/exo_center_controls";
    private static final String CENTER_CONTROLS_CLASS = "android.widget.LinearLayout";
    private static final Bounds SCREEN_BOUNDS =
            new Bounds(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

    private RuntimeTvUpperVideoRoi() { }

    static Admission admit(String foregroundPackage, List<Candidate> candidates) {
        require(PRODUCT_PACKAGE.equals(foregroundPackage),
                "TV product was not the foreground package during ROI admission");
        require(candidates != null, "PlayerView candidate list was missing");

        Admission admitted = null;
        int admittedCount = 0;
        for (Candidate candidate : candidates) {
            if (candidate == null || !candidate.nativePlayerSurfaceAdmitted) continue;
            Admission next = admitCandidate(candidate);
            admittedCount++;
            require(admittedCount == 1,
                    "Multiple exact product-owned native PlayerViews matched ROI admission");
            admitted = next;
        }
        require(admittedCount == 1,
                "No exact product-owned native PlayerView matched ROI admission");
        return admitted;
    }

    static Bounds validateScreenshot(Admission admission, int width, int height) {
        require(admission != null, "Upper-video ROI admission was missing");
        require(width == SCREEN_WIDTH && height == SCREEN_HEIGHT,
                "TV screenshot dimensions did not match the exact admitted geometry");
        require(UPPER_VIDEO_ROI.equals(admission.roi),
                "Upper-video ROI admission was not the exact fixed region");
        return admission.roi;
    }

    private static Admission admitCandidate(Candidate candidate) {
        require(candidate.playerRoot != null,
                "Admitted PlayerView root snapshot was missing");
        require(PRODUCT_PACKAGE.equals(candidate.playerRoot.packageName)
                        && PLAYER_ROOT_CLASS.equals(candidate.playerRoot.className)
                        && candidate.playerRoot.visible,
                "Admitted PlayerView root identity was not exact");
        requireNonEmptyOnScreen(candidate.playerRoot, "PlayerView root");

        Node contentFrame = requireUnique(candidate.contentFrames, "exo_content_frame");
        requireExactNode(contentFrame, CONTENT_FRAME_RESOURCE, CONTENT_FRAME_CLASS,
                "exo_content_frame");
        Node videoSurface = requireUnique(candidate.videoSurfaces, "native SurfaceView");
        requireExactNode(videoSurface, null, VIDEO_SURFACE_CLASS,
                "native SurfaceView");
        Node centerControls = requireUnique(candidate.centerControls, "exo_center_controls");
        requireExactNode(centerControls, CENTER_CONTROLS_RESOURCE, CENTER_CONTROLS_CLASS,
                "exo_center_controls");

        require(candidate.playerRoot.bounds.contains(contentFrame.bounds),
                "Content frame escaped the admitted PlayerView root");
        require(candidate.playerRoot.bounds.contains(videoSurface.bounds),
                "Video surface escaped the admitted PlayerView root");
        require(candidate.playerRoot.bounds.contains(centerControls.bounds),
                "Center controls escaped the admitted PlayerView root");
        require(contentFrame.bounds.contains(UPPER_VIDEO_ROI),
                "Upper-video ROI was outside exo_content_frame");
        require(videoSurface.bounds.contains(UPPER_VIDEO_ROI),
                "Upper-video ROI was outside the native SurfaceView");
        require(!centerControls.bounds.intersects(UPPER_VIDEO_ROI),
                "Upper-video ROI intersected the actual center controls");

        return new Admission(
                UPPER_VIDEO_ROI,
                contentFrame.bounds,
                videoSurface.bounds,
                centerControls.bounds);
    }

    private static Node requireUnique(List<Node> nodes, String label) {
        require(nodes != null && nodes.size() == 1,
                "Expected exactly one " + label + " snapshot");
        Node node = nodes.get(0);
        require(node != null, label + " snapshot was missing");
        return node;
    }

    private static void requireExactNode(
            Node node,
            String resourceName,
            String className,
            String label) {
        require(PRODUCT_PACKAGE.equals(node.packageName)
                        && equal(resourceName, node.resourceName)
                        && className.equals(node.className)
                        && node.visible,
                label + " identity was not exact");
        requireNonEmptyOnScreen(node, label);
    }

    private static void requireNonEmptyOnScreen(Node node, String label) {
        require(node.bounds != null && !node.bounds.isEmpty(),
                label + " bounds were empty");
        require(SCREEN_BOUNDS.contains(node.bounds),
                label + " bounds escaped the exact TV screenshot");
    }

    private static boolean equal(String expected, String actual) {
        return expected == null ? actual == null || actual.isEmpty() : expected.equals(actual);
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    static final class Candidate {
        final boolean nativePlayerSurfaceAdmitted;
        final Node playerRoot;
        final List<Node> contentFrames;
        final List<Node> videoSurfaces;
        final List<Node> centerControls;

        Candidate(
                boolean nativePlayerSurfaceAdmitted,
                Node playerRoot,
                List<Node> contentFrames,
                List<Node> videoSurfaces,
                List<Node> centerControls) {
            this.nativePlayerSurfaceAdmitted = nativePlayerSurfaceAdmitted;
            this.playerRoot = playerRoot;
            this.contentFrames = contentFrames;
            this.videoSurfaces = videoSurfaces;
            this.centerControls = centerControls;
        }
    }

    static final class Node {
        final String packageName;
        final String resourceName;
        final String className;
        final boolean visible;
        final Bounds bounds;

        Node(
                String packageName,
                String resourceName,
                String className,
                boolean visible,
                Bounds bounds) {
            this.packageName = packageName;
            this.resourceName = resourceName;
            this.className = className;
            this.visible = visible;
            this.bounds = bounds;
        }
    }

    static final class Admission {
        final Bounds roi;
        final Bounds contentFrameBounds;
        final Bounds videoSurfaceBounds;
        final Bounds centerControlsBounds;

        private Admission(
                Bounds roi,
                Bounds contentFrameBounds,
                Bounds videoSurfaceBounds,
                Bounds centerControlsBounds) {
            this.roi = roi;
            this.contentFrameBounds = contentFrameBounds;
            this.videoSurfaceBounds = videoSurfaceBounds;
            this.centerControlsBounds = centerControlsBounds;
        }
    }

    static final class Bounds {
        final int left;
        final int top;
        final int right;
        final int bottom;

        Bounds(int left, int top, int right, int bottom) {
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
        }

        int width() {
            return right - left;
        }

        int height() {
            return bottom - top;
        }

        boolean isEmpty() {
            return width() <= 0 || height() <= 0;
        }

        boolean contains(Bounds other) {
            return other != null
                    && left <= other.left
                    && top <= other.top
                    && right >= other.right
                    && bottom >= other.bottom;
        }

        boolean intersects(Bounds other) {
            return other != null
                    && left < other.right
                    && right > other.left
                    && top < other.bottom
                    && bottom > other.top;
        }

        @Override
        public boolean equals(Object other) {
            if (this == other) return true;
            if (!(other instanceof Bounds)) return false;
            Bounds bounds = (Bounds) other;
            return left == bounds.left
                    && top == bounds.top
                    && right == bounds.right
                    && bottom == bounds.bottom;
        }

        @Override
        public int hashCode() {
            int result = left;
            result = 31 * result + top;
            result = 31 * result + right;
            return 31 * result + bottom;
        }
    }
}
