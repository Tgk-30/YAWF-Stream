import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const driver = readFileSync(new URL('./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeForegroundPlaybackFlowTest.java', import.meta.url), 'utf8');
const baselineSha = '36122e1fa1fc54ab29bb1556f8b91a0940db6cbe4fb3aa28437d2a41e007c4bc';
const driverSha = '7990cfd8a79564dbea28960c0c33607665b1d6ed7b1dd0ee7d2d8708054f7821';
const begin = '    // BEGIN SYNTHETIC LOGIN SUBMIT SHORT TAP\n';
const end = '    // END SYNTHETIC LOGIN SUBMIT SHORT TAP\n\n';
const invocation = '        clickSyntheticLoginSubmitOnce();';
const originalInvocation = '        clickLabeled("Sign in", "Sign in", SHORT_WAIT_MS);';
const hash = (text) => createHash('sha256').update(text).digest('hex');

function unique(source, text) {
  assert.equal(source.split(text).length - 1, 1, `Expected one exact derivative boundary: ${text}`);
}
function normalization(source) {
  for (const token of [begin, end, invocation]) unique(source, token);
  assert.equal(source.includes(originalInvocation), false, 'Original submit may not remain beside the new input');
  const first = source.indexOf(begin), last = source.indexOf(end);
  assert.ok(last > first, 'Ordered helper boundaries');
  return (source.slice(0, first) + source.slice(last + end.length)).replace(invocation, originalInvocation);
}
export function assertSubmitTapDerivative(source) {
  assert.equal(hash(source), driverSha, 'Exact reviewed derivative driver');
  assert.equal(hash(normalization(source)), baselineSha, 'Only submit invocation and delimited helper may differ');
}
function between(source, first, last) {
  const a = source.indexOf(first), b = source.indexOf(last, a + first.length);
  assert.ok(a >= 0 && b > a, `Missing source region ${first}`);
  return source.slice(a, b);
}
const helper = between(driver, begin, end).slice(begin.length);
const approval = between(driver, '    private void assertNoOutOfScopeApproval()', '    private static Pattern exactLabel(');
const exactLabel = between(driver, '    private static Pattern exactLabel(', '    private static Pattern exactCaseInsensitiveLabel(');
const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'android-submit-host-'));
after(() => rmSync(work, { recursive: true, force: true }));
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/java') : 'java';
const javac = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/javac') : 'javac';
const compiled = new Map();

const harness = String.raw`
import java.util.*;
import java.util.regex.Pattern;
import java.util.concurrent.TimeoutException;

class android {
  static class os { static class Build { static class VERSION { static int SDK_INT=36; } } }
  static class view { static class Display { static final int DEFAULT_DISPLAY=0; } }
}
class SystemClock {
  static long now;
  static long uptimeMillis() { return now; }
  static void sleep(long value) { now += value; }
}
class Rect {
  int left,top,right,bottom;
  Rect(int l,int t,int r,int b) {left=l;top=t;right=r;bottom=b;}
  Rect(Rect r) {this(r.left,r.top,r.right,r.bottom);}
  int width(){return right-left;} int height(){return bottom-top;}
  int centerX(){return (left+right)/2;} int centerY(){return (top+bottom)/2;}
  public boolean equals(Object other){return other instanceof Rect r&&left==r.left&&top==r.top&&right==r.right&&bottom==r.bottom;}
  public String toString(){return left+","+top+","+right+","+bottom;}
}
class BySelector {
  String role,pkg;Pattern text,description,pkgPattern;Boolean clickable,enabled;
  BySelector clazz(String s){role=s;return this;} BySelector pkg(String s){pkg=s;return this;}
  BySelector text(Pattern p){text=p;return this;} BySelector clickable(boolean b){clickable=b;return this;}
  BySelector enabled(boolean b){enabled=b;return this;}
}
class By {
  static BySelector clazz(String s){return new BySelector().clazz(s);}
  static BySelector text(Pattern p){return new BySelector().text(p);}
  static BySelector desc(Pattern p){BySelector s=new BySelector();s.description=p;return s;}
  static BySelector pkg(Pattern p){BySelector s=new BySelector();s.pkgPattern=p;return s;}
}
class StaleObjectException extends RuntimeException {}
class UiObject2 {
  String role="android.widget.Button",pkg="owned.app",text="Sign in",description="Submit login";
  boolean enabled=true,clickable=true,stale;int display;Rect bounds=new Rect(100,500,500,600);
  void fresh(){if(stale)throw new StaleObjectException();}
  String getClassName(){fresh();return role;}String getApplicationPackage(){fresh();return pkg;}
  String getText(){fresh();return text;}String getContentDescription(){fresh();return description;}
  boolean isEnabled(){fresh();return enabled;}boolean isClickable(){fresh();return clickable;}
  int getDisplayId(){fresh();return display;}Rect getVisibleBounds(){fresh();return bounds;}
}
public class SubmitTapHarness {
  static final String PRODUCT_PACKAGE="owned.app";
  static final Pattern BINDING_TERMS=Pattern.compile("binding");
  String phase="server-login";boolean noInputWindowStarted;
  final UiDevice device=new UiDevice(this);final Instrumentation instrumentation=new Instrumentation(this);
  String scenario;
  static void assertTrue(String why,boolean value){if(!value)throw new AssertionError(why);}
  static void assertNotNull(String why,Object value){assertTrue(why,value!=null);}
  static void assertEquals(String why,Object a,Object b){if(!Objects.equals(a,b))throw new AssertionError(why+": "+a+" != "+b);}
  static void fail(String why){throw new AssertionError(why);}
  static void oracle(boolean value,String why){if(!value)throw new AssertionError("HOST_EXPECTATION: "+why);}
HELPER
APPROVAL
EXACT_LABEL
  static class Instrumentation {
    final UiAutomation automation;Instrumentation(SubmitTapHarness h){automation=new UiAutomation(h);}
    UiAutomation getUiAutomation(){return automation;}
  }
  static class UiAutomation {
    final SubmitTapHarness h;int clears,idles;
    UiAutomation(SubmitTapHarness h){this.h=h;}
    boolean clearCache(){clears++;return !(h.scenario.equals("cache-first")&&clears==1||h.scenario.equals("cache-second")&&clears==2);}
    void waitForIdle(long quiet,long deadline)throws TimeoutException{
      idles++;oracle(quiet==250&&deadline==3000,"fatal idle arguments remain250/3000");
      if(h.scenario.equals("idle-timeout"))throw new TimeoutException("host idle timeout");
      SystemClock.now+=250;
      switch(h.scenario){
        case "geometry-drift":h.device.first.get(0).bounds.right+=20;break;
        case "description-drift":h.device.second.get(0).description="Changed submit identity";break;
        case "foreground-drift":h.device.foreground="other.app";break;
        case "ime-drift":h.device.ime=true;break;
        case "window-drift":h.noInputWindowStarted=true;break;
        case "phase-drift":h.phase="source-selection";break;
        case "forbidden-drift":h.device.binding=true;break;
        case "stale-second":h.device.second.get(0).stale=true;break;
        default:break;
      }
    }
  }
  static class UiDevice {
    final SubmitTapHarness h;String foreground=PRODUCT_PACKAGE;boolean ime,binding;
    final List<UiObject2> first=new ArrayList<>(),second=new ArrayList<>();int queries,clicks,x,y;
    UiDevice(SubmitTapHarness h){this.h=h;first.add(new UiObject2());second.add(new UiObject2());}
    String getCurrentPackageName(){return foreground;}int getDisplayWidth(){return 1080;}int getDisplayHeight(){return 1920;}
    boolean hasObject(BySelector s){return s.pkgPattern!=null&&ime;}
    UiObject2 findObject(BySelector s){return binding&&(s.text==BINDING_TERMS||s.description==BINDING_TERMS)?new UiObject2():null;}
    List<UiObject2> findObjects(BySelector s){
      List<UiObject2> source=queries++==0?first:second;List<UiObject2> found=new ArrayList<>();
      for(UiObject2 n:source){
        if(s.role!=null&&!s.role.equals(n.role)||s.pkg!=null&&!s.pkg.equals(n.pkg)||s.text!=null&&!s.text.matcher(n.text).matches()||s.clickable!=null&&s.clickable!=n.clickable||s.enabled!=null&&s.enabled!=n.enabled)continue;
        found.add(n);
      }
      return found;
    }
    boolean click(int px,int py){
      clicks++;x=px;y=py;
      SystemClock.now+=h.scenario.equals("overrun")?251:h.scenario.equals("cap-boundary")?250:100;
      if(h.scenario.equals("dispatch-throws"))throw new IllegalStateException("uncertain host dispatch");
      return !h.scenario.equals("dispatch-false");
    }
  }
  void configure(String name){
    scenario=name;
    switch(name){
      case "heading-plus-button":UiObject2 heading=new UiObject2();heading.role="android.widget.TextView";heading.clickable=false;device.first.add(heading);device.second.add(heading);break;
      case "ambiguous":device.first.add(new UiObject2());device.second.add(new UiObject2());break;
      case "wrong-role":device.first.get(0).role="android.widget.TextView";break;
      case "wrong-package":device.first.get(0).pkg="other.app";break;
      case "disabled":device.first.get(0).enabled=false;break;
      case "not-clickable":device.first.get(0).clickable=false;break;
      case "wrong-label":device.first.get(0).text="Sign in heading";break;
      case "other-display":device.first.get(0).display=1;break;
      case "empty-bounds":device.first.get(0).bounds.right=100;break;
      case "offscreen":device.first.get(0).bounds.left=-1;break;
      case "foreground":device.foreground="other.app";break;
      case "forbidden":device.binding=true;break;
      case "settings":device.foreground="com.android.settings";break;
      case "ime":device.ime=true;break;
      case "measured-window":noInputWindowStarted=true;break;
      case "wrong-phase":phase="source-selection";break;
      case "api33":android.os.Build.VERSION.SDK_INT=33;break;
      case "stale-first":device.first.get(0).stale=true;break;
      case "geometry-drift":device.second.set(0,device.first.get(0));break;
      default:break;
    }
  }
  public static void main(String[]args)throws Exception{
    SubmitTapHarness h=new SubmitTapHarness();h.configure(args[0]);
    Set<String> allowed=Set.of("success","heading-plus-button","cap-boundary","second-call");
    Set<String> attempted=Set.of("dispatch-false","dispatch-throws","overrun");
    Throwable failure=null;try{h.clickSyntheticLoginSubmitOnce();}catch(Throwable error){failure=error;}
    boolean success=allowed.contains(args[0]);oracle(success?failure==null:failure!=null,"expected "+(success?"success":"refusal")+" for "+args[0]);
    oracle(h.device.clicks==(success||attempted.contains(args[0])?1:0),"exactly one authorized attempted tap, zero before refused admission");
    if(success){oracle(h.device.x==300&&h.device.y==550,"tap uses stable button center, not heading/screenshot coordinates");oracle(h.device.queries==2&&h.instrumentation.automation.clears==2&&h.instrumentation.automation.idles==1,"two fresh targets around one fatal idle barrier");}
    if(success||attempted.contains(args[0])){
      Throwable duplicate=null;try{h.clickSyntheticLoginSubmitOnce();}catch(Throwable error){duplicate=error;}
      oracle(duplicate!=null,"second invocation after attempted input must refuse");oracle(h.device.clicks==1,"no retry or compensating input after success or uncertain dispatch");
    }
    System.out.println("HOST_ONLY submit tap passed: "+args[0]);
  }
}
`;

function replaceUnique(source, before, after) {
  unique(source, before);
  return source.replace(before, after);
}
const mutants = new Map([
  ['ambiguity', ['1, matches.size()', 'true, matches.size() >= 1', 'ambiguous']],
  ['foreground', ['PRODUCT_PACKAGE, device.getCurrentPackageName()', 'PRODUCT_PACKAGE, PRODUCT_PACKAGE', 'foreground-drift']],
  ['window', ['!noInputWindowStarted', 'true', 'window-drift']],
  ['ime', ['!device.hasObject(By.pkg(Pattern.compile(".*inputmethod.*")))', 'true', 'ime-drift']],
  ['cache-result', ['assertTrue("Synthetic login submit accessibility cache refresh failed",\n                instrumentation.getUiAutomation().clearCache());', 'instrumentation.getUiAutomation().clearCache();', 'cache-second']],
  ['idle', ['instrumentation.getUiAutomation().waitForIdle(250L, 3_000L);', ';', 'idle-timeout']],
  ['immutable-bounds', ['new Rect(before.getVisibleBounds())', 'before.getVisibleBounds()', 'geometry-drift']],
  ['stable-geometry', ['beforeBounds, afterBounds', 'beforeBounds, beforeBounds', 'geometry-drift']],
  ['stable-description', ['beforeDescription, after.getContentDescription()', 'beforeDescription, beforeDescription', 'description-drift']],
  ['default-display', ['android.view.Display.DEFAULT_DISPLAY, target.getDisplayId()', 'android.view.Display.DEFAULT_DISPLAY, android.view.Display.DEFAULT_DISPLAY', 'other-display']],
  ['dispatch-result', ['assertTrue("Synthetic login submit dispatch failed", dispatched);', 'assertTrue("Synthetic login submit dispatch failed", true);', 'dispatch-false']],
  ['dispatch-cap', ['dispatchMs >= 0 && dispatchMs <= 250L', 'true', 'overrun']],
  ['once-only', ['syntheticLoginSubmitAttempted = true;', 'syntheticLoginSubmitAttempted = false;', 'second-call']],
  ['retry-on-false', ['boolean dispatched = device.click(afterBounds.centerX(), afterBounds.centerY());', 'boolean dispatched = device.click(afterBounds.centerX(), afterBounds.centerY());\n        if (!dispatched) device.click(afterBounds.centerX(), afterBounds.centerY());', 'dispatch-false']],
  ['fresh-after-idle', ['UiObject2 after = freshSyntheticLoginSubmitTarget();', 'UiObject2 after = before;', 'window-drift']],
]);
function compile(mutation = 'none') {
  if (compiled.has(mutation)) return compiled.get(mutation);
  const body = mutation === 'none' ? helper : replaceUnique(helper, ...mutants.get(mutation).slice(0, 2));
  const directory = join(work, mutation);
  mkdirSync(directory);
  const source = join(directory, 'SubmitTapHarness.java');
  writeFileSync(source, harness.replace('HELPER', body).replace('APPROVAL', approval).replace('EXACT_LABEL', exactLabel));
  if (process.env.JAVA_HOME) assert.ok(existsSync(javac), 'Required JDK compiler must exist; no skips or installation fallback');
  const result = spawnSync(javac, ['-J-XX:-UsePerfData', '-J-Xmx128m', `-J-Djava.io.tmpdir=${work}`, '-encoding', 'UTF-8', '-d', directory, source], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  compiled.set(mutation, directory);
  return directory;
}
function execute(scenario, mutation = 'none') {
  return spawnSync(java, ['-XX:-UsePerfData', '-Xmx128m', `-Djava.io.tmpdir=${work}`, '-cp', compile(mutation), 'SubmitTapHarness', scenario], { encoding: 'utf8', timeout: 5_000 });
}

test('submit-only derivative normalizes to the exact original driver bytes', () => {
  assertSubmitTapDerivative(driver);
  assert.equal(hash(normalization(driver)), baselineSha);
  const original = normalization(driver);
  assert.match(original, /private void guardedClick[\s\S]*?object\.click\(\);\n        SystemClock\.sleep\(500\);/);
  assert.match(original, /phase = "source-selection";\n        waitForTextOrDescription\("Watchlist", UI_WAIT_MS/);
  assert.match(original, /UI_WAIT_MS = 90_000/);
});
test('normalization refuses duplicate/missing boundaries, invocation drift and any unrelated driver edit', () => {
  for (const changed of [driver + begin, driver.replace(begin, ''), driver + end, driver.replace(end, ''), driver + invocation, driver.replace(invocation, ''), driver.replace('UI_WAIT_MS = 90_000', 'UI_WAIT_MS = 190_000')]) {
    assert.throws(() => assertSubmitTapDerivative(changed));
  }
  assert.throws(() => normalization(driver + begin));
  assert.throws(() => normalization(driver + invocation));
  assert.notEqual(hash(normalization(driver.replace('UI_WAIT_MS = 90_000', 'UI_WAIT_MS = 190_000'))), baselineSha);
});
for (const scenario of ['success', 'heading-plus-button', 'cap-boundary', 'second-call', 'ambiguous', 'wrong-role', 'wrong-package', 'disabled', 'not-clickable', 'wrong-label', 'other-display', 'empty-bounds', 'offscreen', 'foreground', 'forbidden', 'settings', 'ime', 'measured-window', 'wrong-phase', 'api33', 'cache-first', 'cache-second', 'idle-timeout', 'stale-first', 'stale-second', 'geometry-drift', 'description-drift', 'foreground-drift', 'ime-drift', 'window-drift', 'phase-drift', 'forbidden-drift', 'dispatch-false', 'dispatch-throws', 'overrun']) {
  test(`host-only actual submit helper with fake native API boundary: ${scenario}`, () => {
    const result = execute(scenario);
    assert.equal(result.status, 0, result.stdout + result.stderr || result.error?.message);
  });
}
for (const [name, [, , scenario]] of mutants) {
  test(`individual compiled submit causal mutant: ${name}`, () => {
    const result = execute(scenario, name);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /AssertionError: HOST_EXPECTATION:/, 'Behavioral oracle failure, never compiler/parser/import failure');
  });
}
