package com.yawf.runtimeinstrumentation;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class RuntimeTvClock {
    private static final Pattern CLOCK = Pattern.compile("(?:(\\d+):)?(\\d{2}):(\\d{2})");

    private RuntimeTvClock() { }

    static <T> long readUniqueVisibleTimeBar(
            List<T> candidates,
            Predicate<? super T> visible,
            Function<? super T, String> contentDescription) {
        List<T> visibleCandidates = new ArrayList<>();
        for (T candidate : candidates) {
            if (visible.test(candidate)) visibleCandidates.add(candidate);
        }
        if (visibleCandidates.size() != 1) {
            throw new AssertionError("Expected exactly one visible enabled product Media3 time bar, found "
                    + visibleCandidates.size());
        }
        return parsePositionClock(contentDescription.apply(visibleCandidates.get(0)));
    }

    static long parsePositionClock(String value) {
        String clock = value == null ? "" : value;
        Matcher matcher = CLOCK.matcher(clock);
        if (!matcher.matches()) {
            throw new AssertionError("Media3 time bar content description was not a full clock");
        }
        try {
            long hours = matcher.group(1) == null ? 0 : Long.parseLong(matcher.group(1));
            long minutes = Long.parseLong(matcher.group(2));
            long seconds = Long.parseLong(matcher.group(3));
            if (minutes > 59 || seconds > 59) {
                throw new AssertionError("Media3 time bar clock field was out of range");
            }
            return Math.addExact(
                    Math.addExact(Math.multiplyExact(hours, 3600), Math.multiplyExact(minutes, 60)),
                    seconds);
        } catch (NumberFormatException | ArithmeticException error) {
            throw new AssertionError("Media3 time bar clock overflowed", error);
        }
    }
}
