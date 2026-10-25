import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourcePath = process.env.WEBVIEW_COMPAT_SOURCE ?? join(
  root,
  "scripts/android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeWebViewCompatibilityTest.java",
);
const source = readFileSync(sourcePath, "utf8");
const begin = "    // BEGIN STRUCTURED_HIERARCHY_REDACTION\n";
const end = "    // END STRUCTURED_HIERARCHY_REDACTION\n";

function extractedRedactor(value) {
  const start = value.indexOf(begin);
  const finish = value.indexOf(end, start);
  assert.ok(start >= 0 && finish > start, "structured hierarchy redactor markers are missing");
  return value.slice(start + begin.length, finish);
}

function runExactJavaRedactor(redactor) {
  const directory = mkdtempSync(join(tmpdir(), "yawf-hierarchy-redactor-"));
  const className = "StructuredHierarchyRedactionProbe";
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<hierarchy rotation="0"><node index="0" text="AuthorizationToken123" ` +
    `resource-id="safe" class="android.widget.TextView" package="com.example" ` +
    `content-desc="https://example.invalid/path?session=Secret456" checkable="false" ` +
    `checked="false" clickable="false" enabled="true" focusable="false" focused="false" ` +
    `scrollable="false" long-clickable="false" password="false" selected="false" ` +
    `bounds="[0,0][10,10]" hint='CookieToken789'/></hierarchy>`;
  const java = `
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.xml.sax.helpers.DefaultHandler;

public final class ${className} {
${redactor}
    private static Document parse(String value) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        var builder = factory.newDocumentBuilder();
        builder.setErrorHandler(new DefaultHandler());
        return builder.parse(new ByteArrayInputStream(value.getBytes(StandardCharsets.UTF_8)));
    }

    private static boolean parses(String value) {
        try {
            parse(value);
            return true;
        } catch (Exception expected) {
            return false;
        }
    }

    public static void main(String[] args) throws Exception {
        String xml = ${JSON.stringify(xml)};
        String legacy = URL.matcher(xml).replaceAll("[redacted-url]");
        legacy = SENSITIVE.matcher(legacy).replaceAll("[redacted-sensitive]");
        if (parses(legacy)) throw new AssertionError("legacy blanket replacement must be malformed");

        String redacted = redactHierarchyXml(xml);
        Document parsed = parse(redacted);
        Element node = (Element) parsed.getElementsByTagName("node").item(0);
        if (!"false".equals(node.getAttribute("password"))) {
            throw new AssertionError("structural password attribute changed: " + redacted);
        }
        if (!"false".equals(node.getAttribute("long-clickable"))) {
            throw new AssertionError("neighboring structural attribute changed: " + redacted);
        }
        if (!"[redacted-sensitive]".equals(node.getAttribute("text"))) {
            throw new AssertionError("sensitive text attribute was not redacted: " + redacted);
        }
        if (!"[redacted-url]".equals(node.getAttribute("content-desc"))) {
            throw new AssertionError("URL attribute was not redacted: " + redacted);
        }
        if (!"[redacted-sensitive]".equals(node.getAttribute("hint"))) {
            throw new AssertionError("single-quoted sensitive attribute was not redacted: " + redacted);
        }
        if (redacted.contains("Token123") || redacted.contains("Secret456") || redacted.contains("Token789")) {
            throw new AssertionError("sensitive value survived: " + redacted);
        }
        System.out.println("PASS legacy-malformed structured-valid");
    }
}
`;
  const javaPath = join(directory, `${className}.java`);
  writeFileSync(javaPath, java);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome ? join(javaHome, "bin/javac") : "javac";
  const javaBin = javaHome ? join(javaHome, "bin/java") : "java";
  const compile = spawnSync(javac, [javaPath], { encoding: "utf8" });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  return spawnSync(javaBin, ["-cp", directory, className], { encoding: "utf8" });
}

test("legacy blanket baseline is malformed and structured complete XML parses", () => {
  assert.match(source, /String redacted = redactHierarchyXml\(serializedXml\);/);
  assert.doesNotMatch(source, /SENSITIVE\.matcher\(redacted\)\.replaceAll\("\[redacted-sensitive\]"\);\n        writeBounded/);
  const result = runExactJavaRedactor(extractedRedactor(source));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS legacy-malformed structured-valid/);
});

test("structured boundary mutant cannot redact across XML attribute names", () => {
  const redactor = extractedRedactor(source);
  const mutant = redactor.replace(
    "Matcher attributes = XML_ATTRIBUTE.matcher(xml);",
    "Matcher attributes = SENSITIVE.matcher(xml);",
  );
  assert.notEqual(mutant, redactor);
  const result = runExactJavaRedactor(mutant);
  assert.notEqual(result.status, 0, "blanket sensitive matcher mutant survived");
});

test("sensitive attribute-value redaction cannot be removed", () => {
  const redactor = extractedRedactor(source);
  const mutant = redactor.replace(
    'redacted = SENSITIVE.matcher(redacted).replaceAll("[redacted-sensitive]");',
    "redacted = redacted;",
  );
  assert.notEqual(mutant, redactor);
  const result = runExactJavaRedactor(mutant);
  assert.notEqual(result.status, 0, "no-sensitive-redaction mutant survived");
});
