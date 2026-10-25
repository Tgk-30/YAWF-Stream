package com.yawf.runtimeinstrumentation;

import java.util.function.BooleanSupplier;
import java.util.function.LongConsumer;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/** Runs one native accessibility read without UiAutomator's implicit idle delay. */
final class RuntimeTvNativeObservation {
    static final int MINIMUM_CACHE_CLEAR_API = 34;

    private RuntimeTvNativeObservation() { }

    static <T> T readFresh(
            int apiLevel,
            LongSupplier idleTimeoutReader,
            LongConsumer idleTimeoutWriter,
            BooleanSupplier cacheClearer,
            Supplier<T> reader) {
        if (apiLevel < MINIMUM_CACHE_CLEAR_API) {
            throw new AssertionError("Fresh native accessibility observation requires Android API 34+");
        }
        long savedIdleTimeout = idleTimeoutReader.getAsLong();
        try {
            idleTimeoutWriter.accept(0L);
            if (!cacheClearer.getAsBoolean()) {
                throw new AssertionError("UiAutomation accessibility cache clear failed");
            }
            return reader.get();
        } finally {
            idleTimeoutWriter.accept(savedIdleTimeout);
        }
    }
}
