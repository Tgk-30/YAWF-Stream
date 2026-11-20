import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLException;

/**
 * Anonymous transport comparison for the fixed public phone channel. Run this
 * separately from the installed app, without changing its network settings,
 * signing, or updater decisions. Never emit server text or redirect locations.
 */
public final class AndroidUpdateTransportProbe {
  private static final String API = "https://api.github.com/repos/Tgk-30/YAWF-Stream";
  private static final String RELEASE = "https://github.com/Tgk-30/YAWF-Stream/releases/download";
  private static final String AGENT = "YAWF-Stream-Android-Updater/1";

  private static final class Refusal extends Exception {
    private final String reason;
    Refusal(String reason) { this.reason = reason; }
  }

  public static void main(String[] args) {
    if (args.length != 1 || !args[0].matches("(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})")) {
      System.out.println("probe=invalid-version-argument");
      System.exit(64);
    }
    String tag = "android-v" + args[0];
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45);
    int failures = 0;
    if (!run("phone-refs", API + "/git/matching-refs/tags/android-v", 512 * 1024, false, deadline)) failures++;
    if (!run("release-metadata", API + "/releases/tags/" + tag, 256 * 1024, false, deadline)) failures++;
    if (!run("canonical-manifest", RELEASE + "/" + tag + "/android-update.json", 16 * 1024, true, deadline)) failures++;
    System.exit(failures == 0 ? 0 : 1);
  }

  private static boolean run(String role, String url, int limit, boolean asset, long deadline) {
    try {
      fetch(role, URI.create(url), limit, asset, deadline);
      return true;
    } catch (Refusal failure) {
      System.out.println(role + " failure=" + failure.reason);
    } catch (java.net.UnknownHostException failure) {
      System.out.println(role + " failure=dns");
    } catch (java.net.SocketTimeoutException failure) {
      System.out.println(role + " failure=timeout");
    } catch (SSLException failure) {
      System.out.println(role + " failure=tls");
    } catch (Exception failure) {
      System.out.println(role + " failure=transport");
    }
    return false;
  }

  private static void fetch(String role, URI uri, int limit, boolean asset, long deadline)
      throws Exception {
    for (int hop = 0; hop <= 5; hop++) {
      HttpURLConnection connection = (HttpURLConnection) uri.toURL().openConnection();
      try {
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(remaining(deadline));
        connection.setReadTimeout(remaining(deadline));
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/vnd.github+json, application/json");
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("User-Agent", AGENT);
        int status = connection.getResponseCode();
        String rate = boundedRemaining(connection.getHeaderField("X-RateLimit-Remaining"));
        String link = connection.getHeaderField("Link");
        boolean hasLink = link != null && !link.trim().isEmpty();
        System.out.println(role + " hop=" + hop + " host=" + uri.getHost()
            + " http=" + status + " remaining=" + rate + " link=" + hasLink);
        if (status >= 300 && status <= 399) {
          if (!asset || hop == 5) throw new Refusal("unexpected-redirect");
          String header = connection.getHeaderField("Location");
          if (header == null || header.trim().isEmpty()) throw new Refusal("missing-redirect");
          URI next = uri.resolve(header);
          if (!allowedAssetRedirect(next)) throw new Refusal("untrusted-redirect");
          uri = next;
          continue;
        }
        if (status != 200) throw new Refusal("http-status");
        if (role.equals("phone-refs") && hasLink) throw new Refusal("paginated-refs");
        if (connection.getContentLengthLong() > limit) throw new Refusal("oversized");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        int total = 0;
        try (InputStream body = connection.getInputStream()) {
          byte[] bytes = new byte[8192];
          for (;;) {
            remaining(deadline);
            int amount = body.read(bytes);
            if (amount < 0) break;
            total += amount;
            if (total > limit) throw new Refusal("oversized");
            digest.update(bytes, 0, amount);
          }
        }
        StringBuilder hex = new StringBuilder(64);
        for (byte value : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        System.out.println(role + " bytes=" + total + " sha256=" + hex);
        return;
      } finally {
        connection.disconnect();
      }
    }
    throw new Refusal("too-many-redirects");
  }

  static boolean allowedAssetRedirect(URI uri) {
    String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
    return "https".equals(uri.getScheme()) && uri.getRawUserInfo() == null
        && uri.getRawFragment() == null && (uri.getPort() == -1 || uri.getPort() == 443)
        && (host.equals("github.com") || host.equals("release-assets.githubusercontent.com")
            || host.equals("objects.githubusercontent.com"));
  }

  static String boundedRemaining(String header) {
    return header != null && header.matches("[0-9]{1,4}") ? header : "unknown";
  }

  private static int remaining(long deadline) throws Refusal {
    long milliseconds = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
    if (milliseconds <= 0) throw new Refusal("deadline");
    return (int) Math.min(10_000L, milliseconds);
  }
}
