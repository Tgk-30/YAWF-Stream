#!/usr/bin/env python3
"""Device-free execution of the real exact42-to74 admission and shared cancellation helper."""
from __future__ import annotations
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeOtaFlowTest.java'
spec = importlib.util.spec_from_file_location('ota_driver_tools', ROOT / 'android-runtime-instrumentation/automatic_ota_driver_mutation_check.py')
assert spec is not None and spec.loader is not None
TOOLS = importlib.util.module_from_spec(spec)
spec.loader.exec_module(TOOLS)
METHODS = ('isAutomaticMode', 'isFixed42AutomaticMode', 'isFixed42To59AutomaticMode', 'isFixed42To61AutomaticMode', 'isFixed42To74AutomaticMode', 'fixed42ProfileName', 'admitAutomaticTargetIdentity', 'admitFixed42To74TargetIdentity', 'parseLongArgument', 'versionCodeFor', 'enableAndCancelInitialFixed42CheckNoIdle', 'assertNoInitialEnableResultVisibleAtCurrentIdlePolicy', 'nativeDialogTextGroup', 'queryFixed42CriticalTextGroup', 'queryFixed42CriticalCancelGroup', 'recordInitialEnableQueryGroupTiming')


def nested_class(source: str, name: str) -> str:
    start = source.index('private static final class ' + name + ' {')
    brace = source.index('{', start)
    depth = 0
    for i in range(brace, len(source)):
        if source[i] == '{': depth += 1
        elif source[i] == '}':
            depth -= 1
            if depth == 0: return source[start:i+1]
    raise AssertionError('Unterminated policy')


HARNESS = r'''
import java.util.*;
import java.util.regex.Pattern;
import java.io.IOException;
public final class Fixed42To74Harness {
    // CONSTANTS
    // POLICY
    String otaMode;
    String admittedBaselineVersion, admittedTargetVersion, admittedTargetSha256, admittedTargetSourceRevision;
    String admittedTargetManifestSha256, admittedTargetVerificationSha256, admittedBaselineSourceRevision;
    String admittedBaselineManifestSha256, admittedBaselineVerificationSha256, admittedUpdaterSourceSha256;
    long admittedTargetVersionCode, admittedTargetSize, admittedTargetBuildRun, admittedBaselineBuildRun;
    boolean targetIdentityAdmitted;
    boolean initialEnableCheckingTitleObserved, initialEnableCheckingMessageObserved, initialEnableCancelObserved;
    boolean initialEnableTerminalResultExcludedBeforeCancel, initialEnableCancelWon;
    int initialEnableCancelSelections, initialEnableSettledResultExclusionSamples;
    long initialEnableLastQueryTimingUptimeMs=-1;
    int initialEnableQueryTimingSequence, initialEnableQueryGroupTimingDrops;
    List<String> initialEnableQueryGroupTimings=new ArrayList<>();
    final Device device=new Device();
    final Instrumentation instrumentation=new Instrumentation();
    static String scenario;
    static void assertTrue(String message,boolean value) { if(!value)throw new AssertionError(message); }
    static void assertFalse(String message,boolean value) { assertTrue(message,!value); }
    static void assertEquals(String message,Object a,Object b) { assertTrue(message,Objects.equals(a,b)); }
    static void fail(String message) { throw new AssertionError(message); }
    void assertNoBindingTermsAtCurrentIdlePolicy() {}
    void capture(String s) throws IOException {}
    void log(String s) {}
    static final class OtaFlowPolicy { static final String SIGNER_SHA256="233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a",PRODUCT_PACKAGE="com.tgk30.debridstreamer"; }
    static final class Bundle {
        final Map<String,String> values=new HashMap<>();
        String getString(String k,String fallback) { return values.getOrDefault(k,fallback); }
    }
    static final class SystemClock {
        static long now;
        static long uptimeMillis() { return now; }
        static void sleep(long ms) { now+=ms; }
    }
    static final class Configurator {
        static final Configurator instance=new Configurator();
        long idle=10000;
        static Configurator getInstance() { return instance; }
        long getWaitForIdleTimeout() { return idle; }
        void setWaitForIdleTimeout(long ms) { idle=ms; }
    }
    static final class BySelector {
        String pkg,res,clazz; Pattern text; Boolean clickable,enabled;
        BySelector pkg(String s){pkg=s;return this;}
        BySelector clazz(String s){clazz=s;return this;}
        BySelector text(Pattern p){text=p;return this;}
        BySelector clickable(boolean b){clickable=b;return this;}
        BySelector enabled(boolean b){enabled=b;return this;}
    }
    static final class By {
        static BySelector res(String p,String id){BySelector s=new BySelector();s.res=p+":id/"+id;return s;}
        static BySelector text(Pattern p){return new BySelector().text(p);}
    }
    final class UiObject2 {
        final String text,pkg,clazz,res; final boolean clickable,enabled;
        UiObject2(String t,String p,String c,String r,boolean click,boolean enable){text=t;pkg=p;clazz=c;res=r;clickable=click;enabled=enable;}
        String getText(){return text;}
        String getApplicationPackage(){return pkg;}
        String getClassName(){return clazz;}
        boolean isClickable(){return clickable;}
        boolean isEnabled(){return enabled;}
        void click(){
            if(text.equals("ENABLE")){device.enableClicks++;device.started=SystemClock.now;device.state="checking";device.cacheFresh=false;}
            else if(text.equals("CANCEL")){
                device.cancelClicks++;
                assertTrue("Only real fresh checking can be cancelled",device.actualState().equals("checking") && enabled && clickable);
                device.state=scenario.equals("terminalAfterCancel")?"terminal":"absent";
            }else throw new AssertionError("Unexpected UI action");
        }
    }
    final class Instrumentation { Automation getUiAutomation(){return new Automation();} }
    final class Automation {
        boolean clearCache(){device.cacheFresh=true;SystemClock.now++;return !scenario.equals("cacheFailure");}
    }
    final class Device {
        int enableClicks,cancelClicks,queriesAfterEnable;
        long started;
        boolean cacheFresh;
        String state="consent";
        String actualState(){
            if(!state.equals("checking"))return state;
            if(scenario.equals("terminalBeforeProgress") || SystemClock.now-started>=500)return "terminal";
            if(scenario.equals("terminalBeforeCancel") && queriesAfterEnable>=4)return "terminal";
            return "checking";
        }
        List<UiObject2> findObjects(BySelector selector){
            SystemClock.now+=Configurator.instance.idle>0?600:1;
            if(enableClicks>0)queriesAfterEnable++;
            String active=actualState();
            if(scenario.equals("staleCache") && !cacheFresh && enableClicks>0)active="consent";
            List<UiObject2> all=new ArrayList<>();
            String product=OtaFlowPolicy.PRODUCT_PACKAGE;
            if(active.equals("consent")){
                all.add(new UiObject2("ENABLE",product,"android.widget.Button","android:id/button1",true,true));
                if(scenario.equals("duplicateEnable"))all.add(new UiObject2("ENABLE",product,"android.widget.Button","android:id/button1",true,true));
            }
            if(active.equals("checking")){
                String pkg=scenario.equals("wrongPackage")?"other.package":product;
                String clazz=scenario.equals("wrongClass")?"android.view.View":"android.widget.TextView";
                all.add(new UiObject2("Checking for updates",pkg,clazz,"",false,true));
                if(scenario.equals("duplicateProgress"))all.add(new UiObject2("Checking for updates",pkg,clazz,"",false,true));
                if(!scenario.equals("missingMessage"))all.add(new UiObject2("Checking the official YAWF Stream Android release channel.",pkg,clazz,"",false,true));
                if(!(scenario.equals("missingFreshCancel") && queriesAfterEnable>=5))all.add(new UiObject2("CANCEL",product,"android.widget.Button","android:id/button2",true,true));
            }
            if(active.equals("terminal"))all.add(new UiObject2("YAWF Stream 2.3.74 is available",product,"android.widget.TextView","",false,true));
            List<UiObject2> found=new ArrayList<>();
            for(UiObject2 node:all){
                if(selector.pkg!=null&&!selector.pkg.equals(node.pkg))continue;
                if(selector.clazz!=null&&!selector.clazz.equals(node.clazz))continue;
                if(selector.res!=null&&!selector.res.equals(node.res))continue;
                if(selector.text!=null&&!selector.text.matcher(node.text).matches())continue;
                if(selector.clickable!=null&&selector.clickable!=node.clickable)continue;
                if(selector.enabled!=null&&selector.enabled!=node.enabled)continue;
                found.add(node);
            }
            return found;
        }
    }
    // METHODS
    Bundle exactArguments(){
        Bundle b=new Bundle();
        b.values.put("baselineVersion",FIXED42_BASELINE_VERSION);
        b.values.put("baselineVersionCode",String.valueOf(FIXED42_BASELINE_VERSION_CODE));
        b.values.put("baselineSha256",FIXED42_BASELINE_SHA256);
        b.values.put("baselineSize",String.valueOf(FIXED42_BASELINE_SIZE));
        b.values.put("baselineSourceRevision",FIXED42_BASELINE_SOURCE);
        b.values.put("baselineManifestSha256",FIXED42_BASELINE_MANIFEST_SHA256);
        b.values.put("baselineVerificationSha256",FIXED42_BASELINE_VERIFICATION_SHA256);
        b.values.put("baselineBuildRun",String.valueOf(FIXED42_BASELINE_BUILD_RUN));
        b.values.put("targetVersion",FIXED42_TO74_TARGET_VERSION);
        b.values.put("targetVersionCode",String.valueOf(FIXED42_TO74_TARGET_VERSION_CODE));
        b.values.put("targetSha256",FIXED42_TO74_TARGET_SHA256);
        b.values.put("targetSize",String.valueOf(FIXED42_TO74_TARGET_SIZE));
        b.values.put("targetSourceRevision",FIXED42_TO74_TARGET_SOURCE);
        b.values.put("targetManifestSha256",FIXED42_TO74_TARGET_MANIFEST_SHA256);
        b.values.put("targetVerificationSha256",FIXED42_TO74_TARGET_VERIFICATION_SHA256);
        b.values.put("targetBuildRun",String.valueOf(FIXED42_TO74_TARGET_BUILD_RUN));
        b.values.put("targetApkName","YAWF.Stream_Android_2.3.74.apk");
        b.values.put("signerSha256",OtaFlowPolicy.SIGNER_SHA256);
        b.values.put("updaterSourceSha256",FIXED42_UPDATER_SHA256);
        b.values.put("runtimeProfile",FIXED42_TO74_AUTOMATIC_OTA_PROFILE);
        b.values.put("targetPublicRelease","true");
        return b;
    }
    static void admission(String field){
        Fixed42To74Harness h=new Fixed42To74Harness();h.otaMode=FIXED42_TO74_AUTOMATIC_OTA_PROFILE;
        Bundle b=h.exactArguments();
        if(!field.equals("valid")){
            if(field.equals("old61Profile"))h.otaMode=FIXED42_TO61_AUTOMATIC_OTA_PROFILE;
            else if(field.equals("old27Profile"))h.otaMode=AUTOMATIC_OTA_MODE;
            else b.values.put(field,field.equals("baselineVersion")?"2.3.27":"wrong");
        }
        boolean rejected=false;
        try{assertTrue("Automatic dispatch",h.isAutomaticMode());h.admitAutomaticTargetIdentity(b);}catch(AssertionError expected){rejected=true;}
        assertTrue("Exact admission "+field,rejected!=field.equals("valid"));
        if(field.equals("valid")){
            assertTrue("Actual fixed42 flow dispatch",h.isFixed42AutomaticMode()&&!h.isFixed42To61AutomaticMode()&&!h.isFixed42To59AutomaticMode());
            assertTrue("Actual target admitted",h.targetIdentityAdmitted);
            assertEquals("Dedicated marker","Fixed42OTA74Marker",h.fixed42ProfileName());
        }
    }
    public static void main(String[] args)throws Exception{
        if(args[0].equals("admission")){admission(args[1]);return;}
        scenario=args[0];Fixed42To74Harness h=new Fixed42To74Harness();h.admittedTargetVersion="2.3.74";
        boolean shouldPass=scenario.equals("fastProgress")||scenario.equals("staleCache");
        boolean rejected=false;
        try{h.enableAndCancelInitialFixed42CheckNoIdle();}catch(AssertionError expected){rejected=true;if(shouldPass)throw expected;}
        assertTrue("Expected cancellation outcome "+scenario,rejected!=shouldPass);
        assertEquals("Idle timeout restored",10000L,Configurator.instance.idle);
        assertTrue("One Enable maximum",h.device.enableClicks<=1);
        assertTrue("One Cancel maximum",h.device.cancelClicks<=1);
        if(shouldPass){
            assertEquals("Real Enable",1,h.device.enableClicks);assertEquals("Real Cancel",1,h.device.cancelClicks);
            assertTrue("All actual observations",h.initialEnableCheckingTitleObserved&&h.initialEnableCheckingMessageObserved&&h.initialEnableCancelObserved&&h.initialEnableTerminalResultExcludedBeforeCancel&&h.initialEnableCancelWon);
            assertEquals("Three settled observations",3,h.initialEnableSettledResultExclusionSamples);
        }else assertFalse("No fake cancellation receipt",h.initialEnableCancelWon);
        if(scenario.equals("terminalBeforeProgress")||scenario.equals("terminalBeforeCancel"))assertEquals("No cancellation after result",0,h.device.cancelClicks);
    }
}
'''


def compile_helper(source: str, destination: Path) -> Path:
    constants='\n'.join(re.findall(r'private static final (?:String(?:\[\])?|long|int|Pattern) [^;]+;', source))
    methods='\n'.join(TOOLS.extract_method(source,n) for n in METHODS)
    text=HARNESS.replace('// CONSTANTS',constants).replace('// POLICY',nested_class(source,'Fixed42CriticalQueryGroupPolicy')).replace('// METHODS',methods)
    destination.mkdir()
    path=destination/'Fixed42To74Harness.java';path.write_text(text)
    result=subprocess.run([TOOLS.java_tool('javac'),'-d',str(destination),str(path)],capture_output=True,text=True,timeout=30)
    if result.returncode:raise AssertionError(result.stderr[-5000:])
    return destination


def execute(classes: Path,*arguments: str):
    return subprocess.run([TOOLS.java_tool('java'),'-cp',str(classes),'Fixed42To74Harness',*arguments],capture_output=True,text=True,timeout=10)


class Fixed42To74ActualHelperTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='yawf-42-to74-helper-');cls.root=Path(cls.temp.name)
        cls.source=SOURCE.read_text();cls.classes=compile_helper(cls.source,cls.root/'baseline')
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()
    def test_exact_admission_and_cross_profile_isolation(self):
        fields=('valid','baselineVersion','baselineVersionCode','baselineSha256','baselineSize','baselineSourceRevision','baselineManifestSha256','baselineVerificationSha256','baselineBuildRun','targetVersion','targetVersionCode','targetSha256','targetSize','targetSourceRevision','targetManifestSha256','targetVerificationSha256','targetBuildRun','targetApkName','signerSha256','updaterSourceSha256','runtimeProfile','targetPublicRelease','old61Profile','old27Profile')
        for field in fields:
            with self.subTest(field=field):
                result=execute(self.classes,'admission',field);self.assertEqual(result.returncode,0,result.stdout+result.stderr)
    def test_actual_shared_cancellation_observer(self):
        for scenario in ('fastProgress','staleCache','terminalBeforeProgress','terminalBeforeCancel','terminalAfterCancel','missingFreshCancel','duplicateEnable','duplicateProgress','missingMessage','wrongPackage','wrongClass','cacheFailure'):
            with self.subTest(scenario=scenario):
                result=execute(self.classes,scenario);self.assertEqual(result.returncode,0,result.stdout+result.stderr)
    def test_individual_causal_mutants(self):
        methods='\n'.join(TOOLS.extract_method(self.source,n) for n in METHODS)
        mutants=(
            ('idleWait','fastProgress','configurator.setWaitForIdleTimeout(0L);','configurator.setWaitForIdleTimeout(10_000L);'),
            ('cancelSelection','fastProgress','freshCancels.get(0).click();','/* Cancel omitted */'),
            ('cancelCount','fastProgress','initialEnableCancelSelections++;','/* Count omitted */'),
            ('settledReceipt','fastProgress','initialEnableCancelWon = true;','initialEnableCancelWon = false;'),
            ('profileDispatch','admission','if (isFixed42To74AutomaticMode()) return true;','if (isFixed42To74AutomaticMode()) return false;'),
            ('targetSource','admission:targetSourceRevision','assertEquals("Fixed42-to74 target source mismatch",\n                FIXED42_TO74_TARGET_SOURCE, admittedTargetSourceRevision);','/* Source guard omitted */'),
            ('markerIdentity','admission','return "Fixed42OTA74Marker";','return "Fixed42OTA61Marker";'),
        )
        receipts=[]
        for name,scenario,before,after in mutants:
            with self.subTest(mutant=name):
                self.assertEqual(methods.count(before),1)
                changed=self.source.replace(before,after,1)
                classes=compile_helper(changed,self.root/name)
                result=execute(classes,'admission',scenario.split(':',1)[1] if ':' in scenario else 'valid') if scenario.startswith('admission') else execute(classes,scenario)
                self.assertNotEqual(result.returncode,0,'Mutant survived '+name)
                receipts.append({'mutant':name,'killed':True,'exit':result.returncode})
        print(json.dumps({'actualAdmissionCases':24,'actualCancellationCases':12,'individualMutants':receipts}))

BOUNDS_HARNESS = r'''
import java.util.*;
public final class Fixed42RoundedBoundsHarness {
    static final String PRODUCT="com.tgk30.debridstreamer";
    static final String FIXED42_TO74_AUTOMATIC_OTA_PROFILE="public-fixed42-to74-initial-cancel-due-resume-v1";
    String otaMode=FIXED42_TO74_AUTOMATIC_OTA_PROFILE;
    static final class OtaFlowPolicy { static final String PRODUCT_PACKAGE=PRODUCT; }
    static void assertTrue(String m,boolean b){if(!b)throw new AssertionError(m);}
    static final class Rect {
        int left,top,right,bottom;
        Rect(){}
        Rect(int l,int t,int r,int b){left=l;top=t;right=r;bottom=b;}
        boolean contains(Rect r){return left<=r.left&&top<=r.top&&right>=r.right&&bottom>=r.bottom;}
        public boolean equals(Object o){if(!(o instanceof Rect))return false;Rect r=(Rect)o;return left==r.left&&top==r.top&&right==r.right&&bottom==r.bottom;}
    }
    static final class AccessibilityNodeInfo {
        String pkg=PRODUCT,clazz="android.view.View",resource="",text="",description="";
        boolean visible=true,scrollable=false,clickable=false,enabled=true;
        Rect bounds=new Rect(0,0,1080,1920);
        CharSequence getText(){return text;}
        CharSequence getContentDescription(){return description;}
        CharSequence getPackageName(){return pkg;}
        CharSequence getClassName(){return clazz;}
        String getViewIdResourceName(){return resource;}
        boolean isVisibleToUser(){return visible;}
        boolean isScrollable(){return scrollable;}
        boolean isClickable(){return clickable;}
        boolean isEnabled(){return enabled;}
        void getBoundsInScreen(Rect out){out.left=bounds.left;out.top=bounds.top;out.right=bounds.right;out.bottom=bounds.bottom;}
    }
    // AX_NODE
    // METHODS
    public static void main(String[] args){
        String test=args[0];Fixed42RoundedBoundsHarness h=new Fixed42RoundedBoundsHarness();
        List<AccessibilityNodeInfo> info=new ArrayList<>();
        for(int i=0;i<5;i++)info.add(new AccessibilityNodeInfo());
        info.get(0).clazz="android.widget.FrameLayout";
        info.get(1).clazz="android.webkit.WebView";info.get(2).clazz="android.webkit.WebView";
        info.get(2).text="Discover | YAWF Stream";
        info.get(4).resource="main-content";info.get(4).scrollable=true;
        info.get(4).bounds=new Rect(0,0,1082,1922);
        int[] parent={-1,0,1,2,3};int mainIndex=4;float density=2.625f;
        switch(test){
            case "observed":break;
            case "onePhysicalPixel":info.get(4).bounds=new Rect(0,0,1081,1921);break;
            case "exact":info.get(4).bounds=new Rect(0,0,1080,1920);break;
            case "wrongOwner":info.get(2).pkg="wrong.owner";break;
            case "wrongRootOwner":info.get(0).pkg="wrong.owner";break;
            case "wrongOwnerClass":info.get(2).clazz="android.view.View";break;
            case "cropped":info.get(2).bounds.right=1079;break;
            case "croppedAncestor":info.get(3).bounds.bottom=1919;break;
            case "translated":info.get(4).bounds.left=1;break;
            case "translatedTop":info.get(4).bounds.top=1;break;
            case "negativeOrigin":info.get(4).bounds.left=-1;break;
            case "underfill":info.get(4).bounds.right=1079;break;
            case "underfillBottom":info.get(4).bounds.bottom=1919;break;
            case "overhang":info.get(4).bounds.right=1083;break;
            case "bottomOverhang":info.get(4).bounds.bottom=1923;break;
            case "ownerOverhang":info.get(2).bounds.right=1082;break;
            case "ancestorOverhang":info.get(3).bounds.right=1200;break;
            case "duplicateOwner":info.add(new AccessibilityNodeInfo());info.get(5).clazz="android.webkit.WebView";break;
            case "duplicateMain":info.add(new AccessibilityNodeInfo());info.get(5).resource="main-content";break;
            case "notAnAncestor":parent[4]=0;break;
            case "cycle":parent[3]=4;break;
            case "negativeParent":parent[0]=-2;break;
            case "wrongIndex":mainIndex=3;break;
            case "wrongMainPackage":info.get(4).pkg="wrong.owner";break;
            case "wrongMainClass":info.get(4).clazz="android.widget.TextView";break;
            case "invisible":info.get(4).visible=false;break;
            case "notScrollable":info.get(4).scrollable=false;break;
            case "clickable":info.get(4).clickable=true;break;
            case "disabled":info.get(4).enabled=false;break;
            case "hiddenOwner":info.get(2).visible=false;break;
            case "disabledOwner":info.get(2).enabled=false;break;
            case "old61":h.otaMode="public-fixed42-to61-initial-cancel-due-resume-v1";break;
            case "old59":h.otaMode="public-fixed42-to59-initial-cancel-due-resume-v1";break;
            case "old27":h.otaMode="automatic-initial-cancel-due-resume";break;
            case "densityOne":density=1.0f;break;
            case "densityNaN":density=Float.NaN;break;
            case "densityHuge":density=1000f;break;
            default:throw new AssertionError(test);
        }
        List<Fixed42AxNode> nodes=new ArrayList<>();
        for(int i=0;i<info.size();i++)nodes.add(new Fixed42AxNode(info.get(i),i<parent.length?parent[i]:0));
        boolean admitted=false;
        try{admitted=h.fixed42To74RoundedMainBoundsMatch(nodes,mainIndex,1080,1920,density);}catch(AssertionError rejected){}
        boolean expected=Arrays.asList("observed","onePhysicalPixel","exact").contains(test);
        assertTrue("Rounded bounds admission mismatch: "+test,admitted==expected);
    }
}
'''


def compile_bounds_helper(source: str, destination: Path) -> Path:
    names=('fixed42To74RoundedMainBoundsMatch','isFixed42To74AutomaticMode','fixed42UniqueResource','fixed42SemanticEquals','fixed42NodeString')
    code=BOUNDS_HARNESS.replace('// AX_NODE',nested_class(source,'Fixed42AxNode')).replace('// METHODS','\n'.join(TOOLS.extract_method(source,n) for n in names))
    destination.mkdir();path=destination/'Fixed42RoundedBoundsHarness.java';path.write_text(code)
    p=subprocess.run([TOOLS.java_tool('javac'),'-d',str(destination),str(path)],capture_output=True,text=True,timeout=30)
    if p.returncode:raise AssertionError(p.stderr[-4000:])
    return destination


def run_bounds_case(classes: Path, scenario: str):
    return subprocess.run([TOOLS.java_tool('java'),'-cp',str(classes),'Fixed42RoundedBoundsHarness',scenario],capture_output=True,text=True,timeout=10)


class RoundedMainBoundsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='yawf74-rounded-bounds-');cls.root=Path(cls.temp.name);cls.source=SOURCE.read_text()
        cls.classes=compile_bounds_helper(cls.source,cls.root/'baseline')
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()
    def test_actual_raw_bounds_and_ownership_admission(self):
        cases=('observed','onePhysicalPixel','exact','wrongOwner','wrongRootOwner','wrongOwnerClass','cropped','croppedAncestor','translated','translatedTop','negativeOrigin','underfill','underfillBottom','overhang','bottomOverhang','ownerOverhang','ancestorOverhang','duplicateOwner','duplicateMain','notAnAncestor','cycle','negativeParent','wrongIndex','wrongMainPackage','wrongMainClass','invisible','notScrollable','clickable','disabled','hiddenOwner','disabledOwner','old61','old59','old27','densityOne','densityNaN','densityHuge')
        for scenario in cases:
            with self.subTest(scenario=scenario):
                p=run_bounds_case(self.classes,scenario);self.assertEqual(p.returncode,0,p.stdout+p.stderr)
    def test_rounding_is_additive_new74_only_at_the_real_snapshot_callsite(self):
        observer=TOOLS.extract_method(self.source,'observeFixed42SeedSnapshot')
        self.assertIn('boolean boundsMatch = main.bounds.equals(expectedMainBounds);',observer)
        self.assertRegex(observer,r'if \(!boundsMatch && isFixed42To74AutomaticMode\(\)\) \{\s*float density = instrumentation.getTargetContext\(\)\s*\.getResources\(\).getDisplayMetrics\(\).density;\s*boundsMatch = fixed42To74RoundedMainBoundsMatch\(')
        self.assertIn('mainIdentityMatches && boundsMatch',observer)
    def test_individual_bounds_causal_controls(self):
        helper=TOOLS.extract_method(self.source,'fixed42To74RoundedMainBoundsMatch')
        mutants=(
            ('strictOriginal','observed','return totalWebViews == owningWebViews;','return main.bounds.equals(display);'),
            ('profileFence','old61','!isFixed42To74AutomaticMode() || width <= 0','false || width <= 0'),
            ('origin','translated','main.bounds.left != 0 || main.bounds.top != 0','false'),
            ('overhang','overhang','(long) main.bounds.right - width > maximumOutwardPixels','false'),
            ('ownerPackage','wrongRootOwner','!product.equals(ancestor.packageName)','false'),
            ('webviewBounds','ownerOverhang','!display.equals(ancestor.bounds)','false'),
            ('uniqueOwner','duplicateOwner','return totalWebViews == owningWebViews;','return true;'),
        )
        for name,scenario,before,after in mutants:
            with self.subTest(mutant=name):
                self.assertEqual(helper.count(before),1)
                changed=self.source.replace(helper,helper.replace(before,after,1),1)
                classes=compile_bounds_helper(changed,self.root/name);p=run_bounds_case(classes,scenario)
                self.assertNotEqual(p.returncode,0,'Survived '+name)


if __name__=='__main__':unittest.main(verbosity=2)
