#!/usr/bin/env python3
"""Execute the real visible-launcher helper with bounded Android UI doubles, no devices."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeOtaFlowTest.java"
spec = importlib.util.spec_from_file_location("ota_driver_tools", ROOT / "android-runtime-instrumentation/automatic_ota_driver_mutation_check.py")
assert spec is not None and spec.loader is not None
TOOLS = importlib.util.module_from_spec(spec)
spec.loader.exec_module(TOOLS)
METHODS = (
    "launchVisibleAppFromLauncher", "refreshVisibleLauncherObservation",
    "findVisibleLauncherSurface", "findVisibleLauncherIcon", "findUniqueLauncherObject",
    "addDistinctUiObjects", "sameUiIdentity",
)

HARNESS = r'''
import java.util.*;
public final class VisibleLauncherHarness {
    static final String LAUNCHER = "com.google.android.apps.nexuslauncher";
    static final String LABEL = "YAWF Stream";
    static final long SHORT_WAIT_MS = 2000, UI_WAIT_MS = 3000;
    final Device device = new Device();
    final Instrumentation instrumentation = new Instrumentation();
    static String scenario;
    static final class OtaFlowPolicy { static final String PRODUCT_PACKAGE = "com.tgk30.debridstreamer"; }
    static final class Build {
        static final class VERSION { static int SDK_INT = 36; }
        static final class VERSION_CODES { static final int UPSIDE_DOWN_CAKE = 34; }
    }
    static final class SystemClock {
        static long now;
        static long uptimeMillis() { return now; }
        static void sleep(long ms) { now += ms; }
    }
    static void assertTrue(String s, boolean v) { if (!v) throw new AssertionError(s); }
    static void assertFalse(String s, boolean v) { assertTrue(s, !v); }
    static void assertNotNull(String s, Object v) { assertTrue(s, v != null); }
    static void assertEquals(String s, Object a, Object b) { assertTrue(s, Objects.equals(a, b)); }
    void assertNoBindingTerms() { device.termsChecks++; }
    void log(String s) {}
    static final class Rect {
        int left, top, right, bottom;
        Rect(int l, int t, int r, int b) { left=l; top=t; right=r; bottom=b; }
        int height() { return bottom-top; }
        int centerX() { return (left+right)/2; }
        boolean isEmpty() { return left>=right || top>=bottom; }
        boolean contains(int x,int y) { return x>=left && x<right && y>=top && y<bottom; }
        boolean contains(Rect r) { return left<=r.left && top<=r.top && right>=r.right && bottom>=r.bottom; }
        public boolean equals(Object o) { if (!(o instanceof Rect)) return false; Rect r=(Rect)o; return left==r.left && top==r.top && right==r.right && bottom==r.bottom; }
    }
    static final class BySelector {
        String pkg, text, desc, res; Boolean clickable;
        BySelector pkg(String p) { pkg=p; return this; }
        BySelector clickable(boolean c) { clickable=c; return this; }
    }
    static final class By {
        static BySelector pkg(String p) { return new BySelector().pkg(p); }
        static BySelector text(String t) { BySelector s=new BySelector(); s.text=t; return s; }
        static BySelector desc(String d) { BySelector s=new BySelector(); s.desc=d; return s; }
        static BySelector res(String p,String r) { BySelector s=new BySelector(); s.res=p+":id/"+r; return s; }
    }
    static final class Until { static BySelector hasObject(BySelector s) { return s; } }
    final class UiObject2 {
        final String res, pkg, clazz; final Rect bounds;
        final boolean icon, enabled;
        UiObject2(String id, Rect b) { this(id,b,LAUNCHER,"android.view.ViewGroup",false,true); }
        UiObject2(String id, Rect b, String p, String c, boolean i, boolean e) { res=p+":id/"+id; bounds=b; pkg=p; clazz=c; icon=i; enabled=e; }
        String getResourceName() { return res; }
        String getApplicationPackage() { return pkg; }
        String getClassName() { return clazz; }
        Rect getVisibleBounds() { return bounds; }
        boolean isEnabled() { return enabled; }
        boolean isClickable() { return icon; }
        void click() {
            device.clicks++;
            assertTrue("Only actual visible icon can launch", icon && device.iconPresent() && !device.state().equals("recents"));
            device.foreground=OtaFlowPolicy.PRODUCT_PACKAGE;
        }
    }
    final class Instrumentation { Automation getUiAutomation() { return new Automation(); } }
    final class Automation {
        boolean clearCache() { device.refreshes++; device.cacheCleared=true;
            if (scenario.equals("expiredDrawer") && device.refreshes==2) SystemClock.now=SHORT_WAIT_MS+1;
            return !scenario.equals("refreshFailure"); }
    }
    final class Device {
        int homes, swipes, clicks, refreshes, termsChecks;
        String foreground="other.package";
        boolean drawer, cacheCleared;
        String getLauncherPackageName() { return LAUNCHER; }
        String getCurrentPackageName() {
            if (foreground.equals(OtaFlowPolicy.PRODUCT_PACKAGE)) return foreground;
            if (scenario.equals("wrongForeground") || (scenario.equals("delayedHome") && SystemClock.now<600)) return "other.package";
            return LAUNCHER;
        }
        void pressHome() { homes++; }
        void waitForIdle(long ms) {}
        int getDisplayWidth() { return 1080; }
        int getDisplayHeight() { return 1920; }
        String state() {
            if (scenario.equals("recents") || scenario.equals("recentsWithWorkspace")) return "recents";
            if (scenario.equals("fromRecents") && SystemClock.now<600) return "recents";
            if (scenario.equals("cachedOverview") && !cacheCleared) return "recents";
            return drawer ? "drawer" : "workspace";
        }
        boolean iconPresent() {
            return scenario.equals("homeIcon") || scenario.equals("recentsWithWorkspace") || drawer;
        }
        boolean swipe(int x,int y,int endX,int endY,int steps) {
            swipes++;
            if (y>=getDisplayHeight()-48) { scenario="recents"; return true; }
            assertTrue("Drawer input must be on observed workspace", state().equals("workspace"));
            assertTrue("Drawer input must remain in content", y<=1440 && endY>=480 && x==540 && endX==540 && y>endY);
            drawer=true; return true;
        }
        boolean wait(BySelector selector, long ms) {
            return Objects.equals(selector.pkg, foreground);
        }
        boolean hasObject(BySelector s) { return !findObjects(s).isEmpty(); }
        List<UiObject2> findObjects(BySelector s) {
            List<UiObject2> all=new ArrayList<>();
            if (!scenario.equals("rootMissing")) all.add(new UiObject2("launcher",new Rect(0,0,1080,scenario.equals("clippedRoot")?1800:1920)));
            String state=state();
            if (state.equals("recents")) all.add(new UiObject2("overview_panel",new Rect(0,0,1080,1920)));
            if (!state.equals("recents") || scenario.equals("recentsWithWorkspace")) {
                all.add(new UiObject2(drawer?"apps_view":"workspace",new Rect(0,63,1080,1780)));
            }
            if (iconPresent() && !scenario.equals("missingIcon")) {
                Rect bounds=scenario.equals("clippedIcon")?new Rect(100,1800,300,2000):new Rect(100,300,300,500);
                if (scenario.equals("movedIcon") && refreshes>=4) bounds=new Rect(100,600,300,800);
                String pkg=scenario.equals("wrongIconPackage")?"fake.launcher":LAUNCHER;
                String clazz=scenario.equals("wrongIconClass")?"android.widget.Button":"android.widget.TextView";
                all.add(new UiObject2("icon",bounds,pkg,clazz,true,!scenario.equals("disabledIcon")));
                if (scenario.equals("duplicateIcon")) all.add(new UiObject2("second_icon",new Rect(500,300,700,500),pkg,clazz,true,true));
            }
            List<UiObject2> found=new ArrayList<>();
            for (UiObject2 o:all) {
                if (s.pkg!=null && !s.pkg.equals(o.pkg)) continue;
                if (s.res!=null && !s.res.equals(o.res)) continue;
                if (s.text!=null && (!o.icon || !s.text.equals(LABEL))) continue;
                if (s.desc!=null && (!o.icon || !s.desc.equals(LABEL))) continue;
                if (s.clickable!=null && s.clickable!=o.isClickable()) continue;
                found.add(o);
            }
            return found;
        }
    }
    // METHODS
    public static void main(String[] args) {
        scenario=args[0]; String initial=scenario;
        VisibleLauncherHarness h=new VisibleLauncherHarness();
        boolean shouldPass=Arrays.asList("drawer","homeIcon","delayedHome","fromRecents","cachedOverview").contains(initial);
        boolean rejected=false;
        try { h.launchVisibleAppFromLauncher(LABEL,OtaFlowPolicy.PRODUCT_PACKAGE,"test"); }
        catch (AssertionError e) { rejected=true; if (shouldPass) throw e; }
        assertTrue("Launcher outcome did not match "+initial, rejected != shouldPass);
        assertEquals("Only one Home input",1,h.device.homes);
        assertEquals("Only exact visible icon launches",shouldPass?1:0,h.device.clicks);
        assertTrue("At most one drawer gesture",h.device.swipes<=1);
        if (Arrays.asList("wrongForeground","recents","recentsWithWorkspace","rootMissing","clippedRoot","refreshFailure","expiredDrawer").contains(initial))
            assertEquals("No drawer input outside admitted workspace",0,h.device.swipes);
        if (shouldPass) {
            assertEquals("Expected drawer action",initial.equals("homeIcon")?0:1,h.device.swipes);
            assertTrue("Persistent fresh observations used",h.device.refreshes>=2);
        }
        assertTrue("Bounded observation",SystemClock.now<=SHORT_WAIT_MS+150);
        System.out.println("PASS "+initial);
    }
}
'''


def compile_helper(source: str, destination: Path) -> Path:
    methods = "\n".join(TOOLS.extract_method(source, name) for name in METHODS)
    # Admission must remain visible UI only. The doubles intentionally provide no shell/intent API.
    for forbidden in ("startActivity", "executeShellCommand", "pressRecentApps", "ComponentName"):
        if forbidden in methods:
            raise AssertionError(f"Forbidden launcher bypass: {forbidden}")
    destination.mkdir()
    path = destination / "VisibleLauncherHarness.java"
    path.write_text(HARNESS.replace("// METHODS", methods))
    result = subprocess.run([TOOLS.java_tool("javac"), "-d", str(destination), str(path)], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise AssertionError(result.stderr)
    return destination


def run_case(classes: Path, scenario: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([TOOLS.java_tool("java"), "-cp", str(classes), "VisibleLauncherHarness", scenario], capture_output=True, text=True, timeout=10)


class VisibleLauncherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="yawf-visible-launcher-")
        cls.root = Path(cls.temporary.name)
        cls.source = "\n".join(TOOLS.extract_method(SOURCE.read_text(), name) for name in METHODS)
        cls.classes = compile_helper(cls.source, cls.root / "baseline")

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_actual_helper_scenarios(self):
        for scenario in ("drawer", "homeIcon", "delayedHome", "fromRecents", "cachedOverview", "wrongForeground", "recents", "recentsWithWorkspace", "rootMissing", "clippedRoot", "missingIcon", "duplicateIcon", "wrongIconPackage", "wrongIconClass", "disabledIcon", "clippedIcon", "movedIcon", "refreshFailure", "expiredDrawer"):
            with self.subTest(scenario=scenario):
                result = run_case(self.classes, scenario)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_individual_causal_mutants(self):
        mutants = (
            ("gestureEdge", "drawer", "device.swipe(x, startY, x, endY, 30)", "device.swipe(x, height - 2, x, endY, 30)"),
            ("defaultPackage", "delayedHome", "String launcherPackage = device.getLauncherPackageName();", "String launcherPackage = device.getCurrentPackageName();"),
            ("overviewAdmission", "recentsWithWorkspace", 'if (device.hasObject(By.res(launcherPackage, "overview_panel").pkg(launcherPackage))) {', 'if (false && device.hasObject(By.res(launcherPackage, "overview_panel").pkg(launcherPackage))) {'),
            ("foregroundAdmission", "wrongForeground", "if (!launcherPackage.equals(device.getCurrentPackageName())) return null;", "if (false) return null;"),
            ("rootBounds", "clippedRoot", "if (!display.equals(roots.get(0).getVisibleBounds())) return null;", "if (false) return null;"),
            ("freshCache", "cachedOverview", "instrumentation.getUiAutomation().clearCache()", "true"),
            ("iconClass", "wrongIconClass", 'assertEquals("Launcher icon class changed", "android.widget.TextView", icon.getClassName());', 'assertEquals("Launcher icon class changed", icon.getClassName(), icon.getClassName());'),
            ("iconEnabled", "disabledIcon", "icon.isClickable() && icon.isEnabled()", "icon.isClickable()"),
            ("drawerDeadline", "expiredDrawer", 'assertTrue("Launcher deadline elapsed before drawer gesture",\n                            SystemClock.uptimeMillis() < deadline);', 'assertTrue("Launcher deadline elapsed before drawer gesture", true);'),
            ("freshBounds", "movedIcon", "iconBounds, freshIcon.getVisibleBounds());", "freshIcon.getVisibleBounds(), freshIcon.getVisibleBounds());"),
        )
        receipts=[]
        for name, scenario, before, after in mutants:
            with self.subTest(mutant=name):
                self.assertEqual(self.source.count(before),1,f"Expected unique {name} mutation site")
                classes=compile_helper(self.source.replace(before,after,1),self.root/name)
                result=run_case(classes,scenario)
                self.assertNotEqual(result.returncode,0,f"Survived {name}")
                receipts.append({"mutant":name,"scenario":scenario,"killed":True,"exit":result.returncode})
        print(json.dumps({"individualCausalMutants":receipts}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
