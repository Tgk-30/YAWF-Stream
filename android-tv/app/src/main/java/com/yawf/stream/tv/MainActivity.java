package com.yawf.stream.tv;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.ui.PlayerView;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

@UnstableApi
public final class MainActivity extends ComponentActivity {
    private static final String PREFERENCES = "yawf_stream_tv";
    private static final String SERVER_URL = "server_url";
    private static final long PROGRESS_INTERVAL_MS = 5_000;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView webView;
    private PlayerView playerView;
    private ExoPlayer player;
    private String serverBase;
    private boolean closingPlayer;

    private final Runnable progressReporter = new Runnable() {
        @Override
        public void run() {
            if (player == null) return;
            dispatchPlaybackEvent("yawf-android-tv-progress", playbackProgress());
            mainHandler.postDelayed(this, PROGRESS_INTERVAL_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON |
                WindowManager.LayoutParams.FLAG_FULLSCREEN
        );
        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.yawf_background));
        setContentView(root);
        getOnBackPressedDispatcher().addCallback(
            this,
            new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    if (player != null) {
                        releasePlayer(true);
                        return;
                    }
                    if (webView != null && webView.canGoBack()) {
                        webView.goBack();
                        return;
                    }
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        );

        serverBase = getPreferences(MODE_PRIVATE).getString(SERVER_URL, null);
        if (serverBase == null) {
            showServerSetup();
        } else {
            showWebApp();
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    private void showWebApp() {
        releasePlayer(false);
        root.removeAllViews();
        webView = new WebView(this);
        webView.setBackgroundColor(getColor(R.color.yawf_background));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(
            settings.getUserAgentString() + " YAWFStreamTV/2.0.0"
        );

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        webView.addJavascriptInterface(new TVBridge(), "YawfAndroidTV");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(
                WebView view,
                WebResourceRequest request
            ) {
                String target = request.getUrl().toString();
                if (ServerAddress.sameOrigin(serverBase, target)) return false;
                if (!ServerAddress.isHttpOrHttps(target)) {
                    Toast.makeText(
                        MainActivity.this,
                        "This link type is not supported.",
                        Toast.LENGTH_SHORT
                    ).show();
                    return true;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                } catch (RuntimeException error) {
                    Toast.makeText(
                        MainActivity.this,
                        "No app can open this link.",
                        Toast.LENGTH_SHORT
                    ).show();
                }
                return true;
            }
        });

        root.addView(
            webView,
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );
        webView.loadUrl(serverBase + "/tv");
        webView.requestFocus();
    }

    private void showServerSetup() {
        releasePlayer(false);
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        root.removeAllViews();

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        int horizontal = dp(56);
        int vertical = dp(36);
        panel.setPadding(horizontal, vertical, horizontal, vertical);
        FrameLayout.LayoutParams panelParams = new FrameLayout.LayoutParams(
            Math.min(getResources().getDisplayMetrics().widthPixels - dp(80), dp(760)),
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER
        );

        TextView title = new TextView(this);
        title.setText(R.string.server_setup_title);
        title.setTextColor(getColor(R.color.yawf_text));
        title.setTextSize(30);
        title.setGravity(Gravity.CENTER);
        panel.addView(title, matchWidth(dp(58)));

        TextView copy = new TextView(this);
        copy.setText(R.string.server_setup_copy);
        copy.setTextColor(getColor(R.color.yawf_muted));
        copy.setTextSize(18);
        copy.setGravity(Gravity.CENTER);
        panel.addView(copy, matchWidth(dp(96)));

        EditText address = new EditText(this);
        address.setSingleLine(true);
        address.setText(serverBase == null ? "" : serverBase);
        address.setHint(R.string.server_url_hint);
        address.setTextColor(getColor(R.color.yawf_text));
        address.setHintTextColor(getColor(R.color.yawf_muted));
        address.setTextSize(20);
        address.setPadding(dp(18), dp(14), dp(18), dp(14));
        panel.addView(address, matchWidth(dp(72)));

        TextView error = new TextView(this);
        error.setTextColor(getColor(R.color.yawf_gold));
        error.setTextSize(16);
        error.setVisibility(View.GONE);
        error.setPadding(0, dp(12), 0, dp(8));
        panel.addView(error, matchWidth(ViewGroup.LayoutParams.WRAP_CONTENT));

        Button connect = new Button(this);
        connect.setText(R.string.connect);
        connect.setTextSize(20);
        connect.setTextColor(Color.BLACK);
        connect.setAllCaps(false);
        connect.setOnClickListener(view -> {
            String normalized = ServerAddress.normalize(address.getText().toString());
            if (normalized == null) {
                error.setText(R.string.server_url_error);
                error.setVisibility(View.VISIBLE);
                address.requestFocus();
                return;
            }
            serverBase = normalized;
            getPreferences(MODE_PRIVATE)
                .edit()
                .putString(SERVER_URL, normalized)
                .apply();
            showWebApp();
        });
        LinearLayout.LayoutParams connectParams = matchWidth(dp(64));
        connectParams.topMargin = dp(12);
        panel.addView(connect, connectParams);

        root.addView(panel, panelParams);
        address.requestFocus();
    }

    private LinearLayout.LayoutParams matchWidth(int height) {
        return new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            height
        );
    }

    private int dp(int value) {
        return Math.round(
            value * getResources().getDisplayMetrics().density
        );
    }

    private void startNativePlayback(String payload) {
        try {
            JSONObject request = new JSONObject(payload);
            String url = request.getString("url");
            if (!ServerAddress.sameOrigin(serverBase, url)) {
                throw new JSONException("Playback URL is outside the configured server.");
            }
            String title = boundedString(request.optString("title", ""), 240);
            String authorization = nullableHeader(
                request.isNull("authorization")
                    ? null
                    : request.optString("authorization", null)
            );
            String audioLanguage = boundedString(
                request.optString("audioLanguage", ""),
                32
            );
            String subtitleLanguage = boundedString(
                request.optString("subtitleLanguage", ""),
                32
            );
            boolean subtitlesEnabled = request.optBoolean(
                "subtitlesEnabled",
                false
            );
            double startSeconds = Math.max(
                0,
                request.optDouble("startPositionSeconds", 0)
            );

            releasePlayer(false);
            DefaultTrackSelector trackSelector = new DefaultTrackSelector(this);
            DefaultTrackSelector.Parameters.Builder tracks =
                trackSelector.buildUponParameters();
            if (!audioLanguage.isEmpty()) {
                tracks.setPreferredAudioLanguage(audioLanguage);
            }
            if (!subtitleLanguage.isEmpty()) {
                tracks.setPreferredTextLanguage(subtitleLanguage);
            }
            tracks.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, !subtitlesEnabled);
            trackSelector.setParameters(tracks);

            Map<String, String> headers = new LinkedHashMap<>();
            if (authorization != null) {
                headers.put("Authorization", authorization);
            }
            String cookie = PlaybackHeaders.cloudflareCookieHeader(
                CookieManager.getInstance().getCookie(url)
            );
            if (cookie != null) {
                headers.put("Cookie", cookie);
            }

            DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent("YAWF Stream Android TV/2.0.0")
                .setConnectTimeoutMs(15_000)
                .setReadTimeoutMs(30_000)
                .setAllowCrossProtocolRedirects(false)
                .setDefaultRequestProperties(headers);
            player = new ExoPlayer.Builder(this)
                .setTrackSelector(trackSelector)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(http))
                .setAudioAttributes(
                    AudioAttributes.DEFAULT,
                    true
                )
                .setHandleAudioBecomingNoisy(true)
                .setWakeMode(C.WAKE_MODE_NETWORK)
                .build();
            player.addListener(new Player.Listener() {
                @Override
                public void onPlayerError(PlaybackException error) {
                    releasePlayer(false);
                    JSONObject detail = new JSONObject();
                    try {
                        detail.put("message", getString(R.string.player_error));
                    } catch (JSONException ignored) {
                        // Fixed key and resource string cannot fail JSON encoding.
                    }
                    dispatchPlaybackEvent("yawf-android-tv-error", detail);
                }
            });

            playerView = new PlayerView(this);
            playerView.setBackgroundColor(Color.BLACK);
            playerView.setUseController(true);
            playerView.setControllerAutoShow(true);
            playerView.setControllerHideOnTouch(false);
            playerView.setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING);
            playerView.setShowSubtitleButton(true);
            playerView.setKeepScreenOn(true);
            playerView.setContentDescription(
                title.isEmpty() ? getString(R.string.app_name) : title
            );
            playerView.setPlayer(player);
            root.addView(
                playerView,
                new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            );
            playerView.bringToFront();
            playerView.requestFocus();

            player.setMediaItem(MediaItem.fromUri(Uri.parse(url)));
            if (startSeconds > 0 && Double.isFinite(startSeconds)) {
                player.seekTo(Math.round(startSeconds * 1_000));
            }
            player.prepare();
            player.play();
            mainHandler.postDelayed(progressReporter, PROGRESS_INTERVAL_MS);
        } catch (JSONException | RuntimeException error) {
            releasePlayer(false);
            JSONObject detail = new JSONObject();
            try {
                detail.put("message", getString(R.string.player_error));
            } catch (JSONException ignored) {
                // Fixed key and resource string cannot fail JSON encoding.
            }
            dispatchPlaybackEvent("yawf-android-tv-error", detail);
        }
    }

    private static String boundedString(String value, int maxLength) {
        if (value == null) return "";
        String trimmed = value.trim();
        return trimmed.length() <= maxLength
            ? trimmed
            : trimmed.substring(0, maxLength);
    }

    private static String nullableHeader(String value) throws JSONException {
        if (value == null || value.isEmpty()) return null;
        if (
            value.length() > 4_096 ||
            value.indexOf('\r') >= 0 ||
            value.indexOf('\n') >= 0 ||
            !value.startsWith("Bearer ")
        ) {
            throw new JSONException("Invalid playback authorization.");
        }
        return value;
    }

    private JSONObject playbackProgress() {
        JSONObject detail = new JSONObject();
        ExoPlayer current = player;
        try {
            long position = current == null ? 0 : Math.max(0, current.getCurrentPosition());
            long duration = current == null ? C.TIME_UNSET : current.getDuration();
            detail.put("positionSeconds", position / 1_000.0);
            if (duration == C.TIME_UNSET || duration < 0) {
                detail.put("durationSeconds", JSONObject.NULL);
            } else {
                detail.put("durationSeconds", duration / 1_000.0);
            }
        } catch (JSONException ignored) {
            // Fixed keys and numeric values cannot fail JSON encoding.
        }
        return detail;
    }

    private void releasePlayer(boolean notifyWeb) {
        if (closingPlayer) return;
        closingPlayer = true;
        JSONObject progress = playbackProgress();
        mainHandler.removeCallbacks(progressReporter);
        if (playerView != null) {
            playerView.setPlayer(null);
            root.removeView(playerView);
            playerView = null;
        }
        if (player != null) {
            player.release();
            player = null;
        }
        closingPlayer = false;
        if (notifyWeb) {
            dispatchPlaybackEvent("yawf-android-tv-closed", progress);
            if (webView != null) webView.requestFocus();
        }
    }

    private void dispatchPlaybackEvent(String name, JSONObject detail) {
        if (webView == null) return;
        String script =
            "window.dispatchEvent(new CustomEvent(" +
                JSONObject.quote(name) +
                ",{detail:" +
                detail.toString() +
                "}));";
        webView.evaluateJavascript(script, null);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (
            player == null &&
            (keyCode == KeyEvent.KEYCODE_MENU ||
                keyCode == KeyEvent.KEYCODE_SETTINGS)
        ) {
            showServerSetup();
            return true;
        }
        return super.onKeyUp(keyCode, event);
    }

    @Override
    protected void onPause() {
        super.onPause();
        mainHandler.removeCallbacks(progressReporter);
        if (player != null) player.pause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (player != null) {
            mainHandler.removeCallbacks(progressReporter);
            mainHandler.postDelayed(progressReporter, PROGRESS_INTERVAL_MS);
        }
    }

    @Override
    protected void onDestroy() {
        releasePlayer(false);
        if (webView != null) {
            webView.removeJavascriptInterface("YawfAndroidTV");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private final class TVBridge {
        @JavascriptInterface
        public void play(String payload) {
            if (payload == null || payload.length() > 16_384) {
                mainHandler.post(() -> {
                    JSONObject detail = new JSONObject();
                    try {
                        detail.put("message", getString(R.string.player_error));
                    } catch (JSONException ignored) {
                        // Fixed key and resource string cannot fail JSON encoding.
                    }
                    dispatchPlaybackEvent("yawf-android-tv-error", detail);
                });
                return;
            }
            mainHandler.post(() -> startNativePlayback(payload));
        }

        @JavascriptInterface
        public void stop() {
            mainHandler.post(() -> releasePlayer(true));
        }
    }
}
