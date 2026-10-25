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
import android.view.ViewParent;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
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
import androidx.annotation.OptIn;
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
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewStartUpConfig;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@UnstableApi
public final class MainActivity extends ComponentActivity {
    private static final String SERVER_URL = "server_url";
    private static final long PROGRESS_INTERVAL_MS = 5_000;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final WebStartupGate webStartupGate = new WebStartupGate();
    private final WebViewSession webViewSession = new WebViewSession();
    private final ExecutorService webStartupExecutor = Executors.newSingleThreadExecutor(
        runnable -> new Thread(runnable, "yawf-webview-startup")
    );
    private FrameLayout root;
    private WebView webView;
    private long activeWebViewSessionId;
    private PlayerView playerView;
    private ExoPlayer player;
    private String serverBase;
    private boolean closingPlayer;
    // A single failed page load fires several callbacks. Only the first one
    // should swap in the recovery screen.
    private boolean showingConnectionError;
    private boolean webViewFocusableBeforePlayer;
    private boolean webViewFocusableInTouchModeBeforePlayer;
    private int webViewDescendantFocusabilityBeforePlayer = ViewGroup.FOCUS_AFTER_DESCENDANTS;
    private boolean webViewFocusSuppressedForPlayer;

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
            applyWebStartupDecision(webStartupGate.beginStartup());
        } else {
            applyWebStartupDecision(webStartupGate.requestWebApp());
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    private void createWebApp() {
        releasePlayer(false);
        destroyCurrentWebView();
        root.removeAllViews();
        showingConnectionError = false;
        webView = new WebView(this);
        final long sessionId = webViewSession.open();
        activeWebViewSessionId = sessionId;
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
            settings.getUserAgentString() + " YAWFStreamTV/" + BuildConfig.VERSION_NAME
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
                if (!acceptsWebViewCallback(view, sessionId)) return true;
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

            @Override
            public void onReceivedError(
                WebView view,
                WebResourceRequest request,
                WebResourceError error
            ) {
                if (!acceptsWebViewCallback(view, sessionId)) return;
                if (
                    !ConnectionFailure.blocksApp(
                        request.isForMainFrame(),
                        serverBase,
                        request.getUrl().toString()
                    )
                ) {
                    return;
                }
                showConnectionError(
                    view,
                    sessionId,
                    getString(R.string.server_unreachable_copy, serverBase)
                );
            }

            @Override
            public void onReceivedHttpError(
                WebView view,
                WebResourceRequest request,
                WebResourceResponse response
            ) {
                if (!acceptsWebViewCallback(view, sessionId)) return;
                if (
                    !ConnectionFailure.blocksApp(
                        request.isForMainFrame(),
                        serverBase,
                        request.getUrl().toString()
                    ) ||
                    !ConnectionFailure.isFatalHttpStatus(response.getStatusCode())
                ) {
                    return;
                }
                showConnectionError(
                    view,
                    sessionId,
                    getString(
                        R.string.server_unreachable_status,
                        serverBase,
                        response.getStatusCode()
                    )
                );
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

    /**
     * Replaces the WebView with a recovery screen. Without this the app sits on
     * the WebView's own error page, Back exits because the failed load left no
     * history to go back to, and the next launch reloads the same dead address.
     */
    private void showConnectionError(
        WebView failedView,
        long sessionId,
        String message
    ) {
        if (!acceptsWebViewCallback(failedView, sessionId)) return;
        if (showingConnectionError) return;
        showingConnectionError = true;
        // The WebView is mid-callback here, so tear it down on the next loop.
        mainHandler.post(() -> {
            if (!acceptsWebViewCallback(failedView, sessionId)) return;
            releasePlayer(false);
            destroyCurrentWebView();
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
            title.setText(R.string.server_unreachable_title);
            title.setTextColor(getColor(R.color.yawf_text));
            title.setTextSize(30);
            title.setGravity(Gravity.CENTER);
            panel.addView(title, matchWidth(dp(58)));

            TextView copy = new TextView(this);
            copy.setText(message);
            copy.setTextColor(getColor(R.color.yawf_muted));
            copy.setTextSize(18);
            copy.setGravity(Gravity.CENTER);
            panel.addView(copy, matchWidth(ViewGroup.LayoutParams.WRAP_CONTENT));

            Button retry = new Button(this);
            retry.setText(R.string.try_again);
            retry.setTextSize(20);
            retry.setTextColor(Color.BLACK);
            retry.setAllCaps(false);
            retry.setOnClickListener(view -> requestWebApp());
            LinearLayout.LayoutParams retryParams = matchWidth(dp(64));
            retryParams.topMargin = dp(24);
            panel.addView(retry, retryParams);

            Button change = new Button(this);
            change.setText(R.string.change_server);
            change.setTextSize(20);
            change.setTextColor(Color.BLACK);
            change.setAllCaps(false);
            change.setOnClickListener(view -> showServerSetup());
            LinearLayout.LayoutParams changeParams = matchWidth(dp(64));
            changeParams.topMargin = dp(12);
            panel.addView(change, changeParams);

            root.addView(panel, panelParams);
            retry.requestFocus();
        });
    }

    private void showServerSetup() {
        webStartupGate.cancelWebApp();
        showingConnectionError = false;
        releasePlayer(false);
        destroyCurrentWebView();
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
        address.setOnKeyListener((view, keyCode, event) -> {
            if (
                keyCode == KeyEvent.KEYCODE_DPAD_DOWN &&
                event.getAction() == KeyEvent.ACTION_DOWN
            ) {
                connect.requestFocus();
                return true;
            }
            return false;
        });
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
            requestWebApp();
        });
        LinearLayout.LayoutParams connectParams = matchWidth(dp(64));
        connectParams.topMargin = dp(12);
        panel.addView(connect, connectParams);

        // The Menu key is the only way back here once a server is saved, and no
        // remote advertises that, so say it on screen.
        TextView hint = new TextView(this);
        hint.setText(R.string.server_setup_hint);
        hint.setTextColor(getColor(R.color.yawf_muted));
        hint.setTextSize(14);
        hint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hintParams = matchWidth(ViewGroup.LayoutParams.WRAP_CONTENT);
        hintParams.topMargin = dp(20);
        panel.addView(hint, hintParams);

        root.addView(panel, panelParams);
        address.requestFocus();
    }

    private void requestWebApp() {
        applyWebStartupDecision(webStartupGate.requestWebApp());
    }

    private void applyWebStartupDecision(WebStartupGate.Decision decision) {
        if (isFinishing() || isDestroyed()) return;
        switch (decision.presentation) {
            case LOADING:
                showWebStartupLoading();
                break;
            case WEB_APP:
                createWebApp();
                break;
            case ERROR:
                showWebStartupError();
                break;
            case NONE:
                break;
        }
        if (decision.startStartup) {
            startWebViewAsync(decision.startupId);
        }
    }

    @OptIn(markerClass = WebViewCompat.ExperimentalAsyncStartUp.class)
    private void startWebViewAsync(long startupId) {
        Executor guardedExecutor = command -> {
            try {
                webStartupExecutor.execute(() -> {
                    try {
                        command.run();
                    } catch (Throwable error) {
                        notifyWebStartupFailed(startupId);
                    }
                });
            } catch (RuntimeException error) {
                notifyWebStartupFailed(startupId);
            }
        };
        try {
            WebViewStartUpConfig config = new WebViewStartUpConfig.Builder(guardedExecutor)
                .build();
            WebViewCompat.startUpWebView(
                getApplicationContext(),
                config,
                result -> applyWebStartupDecision(webStartupGate.startupReady(startupId))
            );
        } catch (RuntimeException | LinkageError error) {
            applyWebStartupDecision(webStartupGate.startupFailed(startupId));
        }
    }

    private void notifyWebStartupFailed(long startupId) {
        mainHandler.post(
            () -> applyWebStartupDecision(webStartupGate.startupFailed(startupId))
        );
    }

    private void showWebStartupLoading() {
        releasePlayer(false);
        destroyCurrentWebView();
        root.removeAllViews();

        LinearLayout panel = nativeStatusPanel();
        panel.addView(
            nativeStatusText(R.string.web_startup_loading_title, 30, R.color.yawf_text),
            matchWidth(dp(58))
        );
        panel.addView(
            nativeStatusText(R.string.web_startup_loading_copy, 18, R.color.yawf_muted),
            matchWidth(ViewGroup.LayoutParams.WRAP_CONTENT)
        );

        Button change = nativeStatusButton(R.string.change_server);
        change.setOnClickListener(view -> showServerSetup());
        LinearLayout.LayoutParams changeParams = matchWidth(dp(64));
        changeParams.topMargin = dp(24);
        panel.addView(change, changeParams);
        addNativeStatusPanel(panel);
        change.requestFocus();
    }

    private void showWebStartupError() {
        releasePlayer(false);
        destroyCurrentWebView();
        root.removeAllViews();

        LinearLayout panel = nativeStatusPanel();
        panel.addView(
            nativeStatusText(R.string.web_startup_error_title, 30, R.color.yawf_text),
            matchWidth(dp(58))
        );
        panel.addView(
            nativeStatusText(R.string.web_startup_error_copy, 18, R.color.yawf_muted),
            matchWidth(ViewGroup.LayoutParams.WRAP_CONTENT)
        );

        Button retry = nativeStatusButton(R.string.try_again);
        retry.setOnClickListener(view -> requestWebApp());
        LinearLayout.LayoutParams retryParams = matchWidth(dp(64));
        retryParams.topMargin = dp(24);
        panel.addView(retry, retryParams);

        Button change = nativeStatusButton(R.string.change_server);
        change.setOnClickListener(view -> showServerSetup());
        LinearLayout.LayoutParams changeParams = matchWidth(dp(64));
        changeParams.topMargin = dp(12);
        panel.addView(change, changeParams);
        addNativeStatusPanel(panel);
        retry.requestFocus();
    }

    private LinearLayout nativeStatusPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        panel.setPadding(dp(56), dp(36), dp(56), dp(36));
        return panel;
    }

    private TextView nativeStatusText(int text, int size, int color) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(getColor(color));
        view.setTextSize(size);
        view.setGravity(Gravity.CENTER);
        return view;
    }

    private Button nativeStatusButton(int text) {
        Button button = new Button(this);
        button.setText(text);
        button.setTextSize(20);
        button.setTextColor(Color.BLACK);
        button.setAllCaps(false);
        return button;
    }

    private void addNativeStatusPanel(LinearLayout panel) {
        root.addView(
            panel,
            new FrameLayout.LayoutParams(
                Math.min(getResources().getDisplayMetrics().widthPixels - dp(80), dp(760)),
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER
            )
        );
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
            String contentType = nullableContentType(
                request.isNull("contentType")
                    ? null
                    : request.optString("contentType", null)
            );
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
                .setUserAgent("YAWF Stream Android TV/" + BuildConfig.VERSION_NAME)
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
            // Keep D-pad focus inside Media3 while the player is on screen. The
            // WebView remains attached for playback events but must not win focus.
            if (webView != null) {
                webViewFocusableBeforePlayer = webView.isFocusable();
                webViewFocusableInTouchModeBeforePlayer = webView.isFocusableInTouchMode();
                webViewDescendantFocusabilityBeforePlayer = webView.getDescendantFocusability();
                webViewFocusSuppressedForPlayer = true;
                webView.setFocusable(false);
                webView.setFocusableInTouchMode(false);
                webView.setDescendantFocusability(ViewGroup.FOCUS_BLOCK_DESCENDANTS);
            }
            playerView.setFocusable(true);
            playerView.setFocusableInTouchMode(true);
            playerView.bringToFront();
            playerView.requestFocus();

            MediaItem.Builder mediaItem = new MediaItem.Builder()
                .setUri(Uri.parse(url));
            if (contentType != null) {
                mediaItem.setMimeType(contentType);
            }
            player.setMediaItem(mediaItem.build());
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

    private static String nullableContentType(String value) throws JSONException {
        try {
            return PlaybackContentType.normalize(value);
        } catch (IllegalArgumentException error) {
            throw new JSONException("Invalid playback content type.");
        }
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
        if (webViewFocusSuppressedForPlayer && webView != null) {
            webView.setFocusable(webViewFocusableBeforePlayer);
            webView.setFocusableInTouchMode(webViewFocusableInTouchModeBeforePlayer);
            webView.setDescendantFocusability(webViewDescendantFocusabilityBeforePlayer);
            webView.requestFocus();
        }
        webViewFocusSuppressedForPlayer = false;
        if (player != null) {
            player.release();
            player = null;
        }
        closingPlayer = false;
        if (notifyWeb) {
            dispatchPlaybackEvent("yawf-android-tv-closed", progress);
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

    private boolean acceptsWebViewCallback(WebView view, long sessionId) {
        return view != null &&
            view == webView &&
            webViewSession.isActive(sessionId);
    }

    /**
     * Invalidates callbacks first, detaches the current WebView from Android's
     * view hierarchy, and only then destroys it. No caller may retain the old
     * instance after this method returns.
     */
    private void destroyCurrentWebView() {
        WebView current = webView;
        long sessionId = activeWebViewSessionId;
        webView = null;
        activeWebViewSessionId = 0;
        webViewSession.close(sessionId);
        if (current == null) return;

        ViewParent parent = current.getParent();
        if (parent instanceof ViewGroup) {
            ((ViewGroup) parent).removeView(current);
        }
        current.stopLoading();
        current.removeJavascriptInterface("YawfAndroidTV");
        current.destroy();
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
        if (webStartupGate.isReady()) CookieManager.getInstance().flush();
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
        webStartupGate.closeAndShutdown(webStartupExecutor);
        releasePlayer(false);
        destroyCurrentWebView();
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
