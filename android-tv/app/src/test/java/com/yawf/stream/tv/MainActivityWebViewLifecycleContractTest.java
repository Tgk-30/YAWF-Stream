package com.yawf.stream.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public final class MainActivityWebViewLifecycleContractTest {
    @Test
    public void currentWebViewIsDetachedBeforeTheOnlyDestroyCall() throws Exception {
        String source = mainActivitySource();
        String destroy = between(
            source,
            "private void destroyCurrentWebView()",
            "@Override\n    public boolean onKeyUp"
        );

        assertEquals(1, occurrences(source, ".destroy();"));
        assertOrdered(destroy, "webView = null;", "webViewSession.close(sessionId);");
        assertOrdered(destroy, "webViewSession.close(sessionId);", "removeView(current);");
        assertOrdered(destroy, "removeView(current);", "current.destroy();");
    }

    @Test
    public void replacementAndLateCallbacksAreBoundToTheActiveSession() throws Exception {
        String source = mainActivitySource();
        String create = between(source, "private void createWebApp()", "private void showConnectionError(");
        String error = between(source, "private void showConnectionError(", "private void showServerSetup()");

        assertOrdered(create, "destroyCurrentWebView();", "webView = new WebView(this);");
        assertTrue(occurrences(create, "acceptsWebViewCallback(view, sessionId)") >= 3);
        String guard = "if (!acceptsWebViewCallback(failedView, sessionId)) return;";
        assertTrue(occurrences(error, guard) >= 2);
        int posted = error.indexOf("mainHandler.post(() -> {");
        int postedGuard = error.indexOf(guard, posted);
        int destroy = error.indexOf("destroyCurrentWebView();", postedGuard);
        assertTrue(posted >= 0 && postedGuard > posted && destroy > postedGuard);
    }

    @Test
    public void everyNativeReplacementUsesTheCentralDestroyPath() throws Exception {
        String source = mainActivitySource();
        for (String method : new String[] {
            "private void showServerSetup()",
            "private void showWebStartupLoading()",
            "private void showWebStartupError()"
        }) {
            String body = methodBody(source, method);
            assertOrdered(body, "destroyCurrentWebView();", "root.removeAllViews();");
        }
        assertTrue(
            methodBody(source, "protected void onDestroy()")
                .contains("destroyCurrentWebView();")
        );
    }

    private static String mainActivitySource() throws IOException {
        for (Path path : new Path[] {
            Path.of("src/main/java/com/yawf/stream/tv/MainActivity.java"),
            Path.of("app/src/main/java/com/yawf/stream/tv/MainActivity.java")
        }) {
            if (Files.isRegularFile(path)) {
                return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
            }
        }
        throw new IOException("MainActivity.java not found from the test working directory");
    }

    private static String methodBody(String source, String signature) {
        int start = source.indexOf(signature);
        assertTrue("missing " + signature, start >= 0);
        int next = source.indexOf("\n    private ", start + signature.length());
        int nextOverride = source.indexOf("\n    @Override", start + signature.length());
        if (next < 0 || (nextOverride >= 0 && nextOverride < next)) next = nextOverride;
        if (next < 0) next = source.length();
        return source.substring(start, next);
    }

    private static String between(String source, String startText, String endText) {
        int start = source.indexOf(startText);
        int end = source.indexOf(endText, start + Math.max(0, startText.length()));
        assertTrue("missing " + startText, start >= 0);
        assertTrue("missing " + endText, end > start);
        return source.substring(start, end);
    }

    private static int occurrences(String source, String value) {
        int count = 0;
        int offset = 0;
        while ((offset = source.indexOf(value, offset)) >= 0) {
            count += 1;
            offset += value.length();
        }
        return count;
    }

    private static void assertOrdered(String source, String first, String second) {
        int firstIndex = source.indexOf(first);
        int secondIndex = source.indexOf(second);
        assertTrue("missing " + first, firstIndex >= 0);
        assertTrue("missing " + second, secondIndex >= 0);
        assertTrue(first + " must precede " + second, firstIndex < secondIndex);
    }
}
