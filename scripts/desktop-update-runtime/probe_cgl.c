/* Disposable CI capability diagnostic, not a rendering or playback test.
 * Build: xcrun clang -Wno-deprecated-declarations -framework OpenGL probe_cgl.c
 * Run only inside the existing disposable macOS CI guard, with a host deadline.
 */
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <stdbool.h>
#include <stdio.h>

typedef struct {
    bool attempted, production_profile, accelerated_requested, core32_requested;
    CGLError choose_error, describe_error, create_error, set_current_error, restore_error, detach_error;
    GLint pixel_format_count;
    bool pixel_format_present, describe_attempted, accelerated;
    bool create_attempted, context_present, set_current_attempted, version_queried, version_observed;
    unsigned int gl_major, gl_minor;
    GLenum gl_error;
    bool restore_attempted, previous_restored, supported;
} ProbeResult;

static const char *boolean(bool value) { return value ? "true" : "false"; }

static ProbeResult probe(const CGLPixelFormatAttribute *attributes, bool production_profile) {
    ProbeResult result = {0};
    result.attempted = true;
    result.production_profile = production_profile;
    result.accelerated_requested = production_profile;
    result.core32_requested = production_profile;
    CGLPixelFormatObj pixel_format = NULL;
    CGLContextObj context = NULL;
    CGLContextObj previous = CGLGetCurrentContext();
    if (previous != NULL) CGLRetainContext(previous);

    result.choose_error = CGLChoosePixelFormat(attributes, &pixel_format, &result.pixel_format_count);
    result.pixel_format_present = pixel_format != NULL;
    if (result.choose_error == kCGLNoError && pixel_format != NULL && result.pixel_format_count > 0) {
        GLint accelerated = 0;
        result.describe_attempted = true;
        result.describe_error = CGLDescribePixelFormat(pixel_format, 0, kCGLPFAAccelerated, &accelerated);
        result.accelerated = result.describe_error == kCGLNoError && accelerated != 0;
        result.create_attempted = true;
        result.create_error = CGLCreateContext(pixel_format, NULL, &context);
        result.context_present = context != NULL;
        if (result.create_error == kCGLNoError && context != NULL) {
            result.set_current_attempted = true;
            result.set_current_error = CGLSetCurrentContext(context);
            if (result.set_current_error == kCGLNoError) {
                result.version_queried = true;
                const GLubyte *version = glGetString(GL_VERSION);
                result.gl_error = glGetError();
                unsigned int major = 0, minor = 0;
                if (result.gl_error == GL_NO_ERROR && version != NULL &&
                    sscanf((const char *)version, "%u.%u", &major, &minor) == 2 && major > 0 && major < 100 && minor < 100) {
                    result.gl_major = major;
                    result.gl_minor = minor;
                    result.version_observed = true;
                }
            }
        }
    }

    if (context != NULL) {
        result.restore_attempted = true;
        result.restore_error = CGLSetCurrentContext(previous);
    }
    result.previous_restored = result.restore_error == kCGLNoError && CGLGetCurrentContext() == previous;
    /* A failed restore is an execution failure, never unsupported capability.
     * Detach our context before releasing its owned reference in that case.
     */
    if (!result.previous_restored) result.detach_error = CGLSetCurrentContext(NULL);
    if (context != NULL) CGLReleaseContext(context);
    if (pixel_format != NULL) CGLReleasePixelFormat(pixel_format);
    if (previous != NULL) CGLReleaseContext(previous);
    const bool core32 = result.gl_major > 3 || (result.gl_major == 3 && result.gl_minor >= 2);
    result.supported = result.choose_error == kCGLNoError && result.pixel_format_present && result.pixel_format_count > 0 &&
        result.create_attempted && result.create_error == kCGLNoError && result.context_present &&
        result.set_current_attempted && result.set_current_error == kCGLNoError && result.version_observed &&
        (!production_profile || (result.accelerated && core32));
    return result;
}

static void print_result(const ProbeResult *r) {
    printf("{\"attempted\":%s,\"productionProfile\":%s,\"acceleratedRequested\":%s,\"core32Requested\":%s,"
           "\"chooseError\":%d,\"pixelFormatCount\":%d,\"pixelFormatPresent\":%s,\"describeAttempted\":%s,\"describeError\":%d,\"accelerated\":%s,"
           "\"createAttempted\":%s,\"createError\":%d,\"contextPresent\":%s,\"setCurrentAttempted\":%s,\"setCurrentError\":%d,"
           "\"versionQueried\":%s,\"versionObserved\":%s,\"glMajor\":%u,\"glMinor\":%u,\"glError\":%u,"
           "\"restoreAttempted\":%s,\"restoreError\":%d,\"detachError\":%d,\"previousRestored\":%s,\"supported\":%s}",
           boolean(r->attempted), boolean(r->production_profile), boolean(r->accelerated_requested), boolean(r->core32_requested),
           (int)r->choose_error, (int)r->pixel_format_count, boolean(r->pixel_format_present), boolean(r->describe_attempted), (int)r->describe_error, boolean(r->accelerated),
           boolean(r->create_attempted), (int)r->create_error, boolean(r->context_present), boolean(r->set_current_attempted), (int)r->set_current_error,
           boolean(r->version_queried), boolean(r->version_observed), r->gl_major, r->gl_minor, (unsigned int)r->gl_error,
           boolean(r->restore_attempted), (int)r->restore_error, (int)r->detach_error, boolean(r->previous_restored), boolean(r->supported));
}

int main(void) {
    const CGLPixelFormatAttribute production_attributes[] = {
        kCGLPFAAccelerated,
        kCGLPFAOpenGLProfile,
        (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
        (CGLPixelFormatAttribute)0
    };
    /* No requested acceleration/profile: this is a default control, not a
     * replacement for the production profile, and may still be accelerated.
     */
    const CGLPixelFormatAttribute default_control_attributes[] = { (CGLPixelFormatAttribute)0 };
    const ProbeResult production = probe(production_attributes, true);
    ProbeResult control = {0};
    if (!production.supported && production.previous_restored) control = probe(default_control_attributes, false);
    const bool execution_ok = production.previous_restored && (!control.attempted || control.previous_restored);
    fputs("{\"schemaVersion\":1,\"diagnosticOnly\":true,\"offscreenContextOnly\":true,\"provesVideoRendering\":false,\"exactProduction\":", stdout);
    print_result(&production);
    fputs(",\"defaultControl\":", stdout);
    print_result(&control);
    printf(",\"executionSucceeded\":%s}\n", boolean(execution_ok));
    if (ferror(stdout) || fflush(stdout) != 0) return 1;
    return execution_ok ? 0 : 2;
}
