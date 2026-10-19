package com.yawf.stream.tv;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public final class WebStartupGateTest {
    @Test
    public void closeAllowsProcessGlobalStartupToFinishWithoutInterruption() throws Exception {
        WebStartupGate gate = new WebStartupGate();
        WebStartupGate.Decision startup = gate.requestWebApp();
        ExecutorService executor = Executors.newSingleThreadExecutor();
        CountDownLatch running = new CountDownLatch(1);
        CountDownLatch finish = new CountDownLatch(1);
        AtomicBoolean interrupted = new AtomicBoolean(false);
        try {
            executor.execute(() -> {
                running.countDown();
                try {
                    finish.await();
                } catch (InterruptedException error) {
                    interrupted.set(true);
                    Thread.currentThread().interrupt();
                }
            });
            assertTrue(running.await(5, TimeUnit.SECONDS));
            gate.closeAndShutdown(executor);
            finish.countDown();
            assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS));
            assertFalse(interrupted.get());
            assertEquals(
                WebStartupGate.Presentation.NONE,
                gate.startupReady(startup.startupId).presentation
            );
            assertFalse(gate.requestWebApp().startStartup);
        } finally {
            finish.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    public void initialStartupStaysNativeUntilAWebAppIsRequested() {
        WebStartupGate gate = new WebStartupGate();
        WebStartupGate.Decision initial = gate.beginStartup();
        assertTrue(initial.startStartup);
        assertEquals(WebStartupGate.Presentation.NONE, initial.presentation);

        WebStartupGate.Decision connect = gate.requestWebApp();
        assertFalse(connect.startStartup);
        assertEquals(initial.startupId, connect.startupId);
        assertEquals(WebStartupGate.Presentation.LOADING, connect.presentation);
    }

    @Test
    public void readyCallbackPresentsOnlyThePendingWebApp() {
        WebStartupGate gate = new WebStartupGate();
        WebStartupGate.Decision startup = gate.beginStartup();
        gate.requestWebApp();

        WebStartupGate.Decision ready = gate.startupReady(startup.startupId);
        assertEquals(WebStartupGate.Presentation.WEB_APP, ready.presentation);
        assertTrue(gate.isReady());

        WebStartupGate.Decision laterRequest = gate.requestWebApp();
        assertFalse(laterRequest.startStartup);
        assertEquals(WebStartupGate.Presentation.WEB_APP, laterRequest.presentation);
    }

    @Test
    public void failureCanRetryAndIgnoresTheOldAttempt() {
        WebStartupGate gate = new WebStartupGate();
        WebStartupGate.Decision first = gate.requestWebApp();
        assertEquals(WebStartupGate.Presentation.LOADING, first.presentation);

        WebStartupGate.Decision failure = gate.startupFailed(first.startupId);
        assertEquals(WebStartupGate.Presentation.ERROR, failure.presentation);

        WebStartupGate.Decision retry = gate.requestWebApp();
        assertTrue(retry.startStartup);
        assertNotEquals(first.startupId, retry.startupId);
        assertEquals(WebStartupGate.Presentation.LOADING, retry.presentation);
        assertEquals(
            WebStartupGate.Presentation.NONE,
            gate.startupReady(first.startupId).presentation
        );
        assertEquals(
            WebStartupGate.Presentation.WEB_APP,
            gate.startupReady(retry.startupId).presentation
        );
    }

    @Test
    public void cancelPendingConnectPreventsCallbackFromChangingSetup() {
        WebStartupGate gate = new WebStartupGate();
        WebStartupGate.Decision startup = gate.requestWebApp();
        gate.cancelWebApp();

        assertEquals(
            WebStartupGate.Presentation.NONE,
            gate.startupReady(startup.startupId).presentation
        );
        assertEquals(
            WebStartupGate.Presentation.WEB_APP,
            gate.requestWebApp().presentation
        );
    }

    @Test
    public void closeAndStaleCallbacksCannotResurrectTheActivity() {
        WebStartupGate gate = new WebStartupGate();
        WebStartupGate.Decision startup = gate.requestWebApp();
        gate.close();

        assertEquals(
            WebStartupGate.Presentation.NONE,
            gate.startupReady(startup.startupId).presentation
        );
        assertEquals(
            WebStartupGate.Presentation.NONE,
            gate.startupFailed(startup.startupId).presentation
        );
        WebStartupGate.Decision afterClose = gate.requestWebApp();
        assertFalse(afterClose.startStartup);
        assertEquals(WebStartupGate.Presentation.NONE, afterClose.presentation);
    }
}
