/*
    꼬맨틀 오프라인 — 안드로이드 앱.
    web/ 폴더의 화면을 WebView로 띄우고, 유사도 계산은 Engine(전체 단어 데이터)이 한다.
    인터넷 없이 동작한다.
    Licensed under the GNU GPL v3.
*/
package io.github.foggyjupiter.ggomantle;

import android.app.Activity;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.Properties;

public class MainActivity extends Activity {
    // 이 주소는 실제 인터넷이 아니라 WebViewAssetLoader가 APK 안의 파일로 응답한다
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/app/index.html";

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        // app.js가 이 표시를 보고 앱 모드(서비스 워커/캐시 없이)로 동작한다
        settings.setUserAgentString(settings.getUserAgentString() + " GgomantleApp");

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/app/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) return false;
                // 바깥 링크(원본 저장소 등)는 브라우저로
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (Exception ignored) {
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient());  // confirm() 창 표시용
        web.addJavascriptInterface(new Bridge(), "GgoApp");

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    // 뒤로 가기: 열린 창이 있으면 닫고, 없으면 앱 종료
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript(
                "(function(){var d=document.querySelector('dialog[open]');if(d){d.close();return true;}return false;})()",
                value -> {
                    if (!"true".equals(value)) finish();
                });
    }

    // APK 안의 파일을 압축 없이 넣어 두고(noCompress) 그대로 매핑한다 → 메모리에 올리지 않음
    private ByteBuffer map(String name) throws IOException {
        AssetFileDescriptor fd = getAssets().openFd("words/" + name);
        try (FileInputStream in = fd.createInputStream()) {
            return in.getChannel().map(FileChannel.MapMode.READ_ONLY, fd.getStartOffset(), fd.getLength());
        }
    }

    private Engine engine;

    private class Bridge {
        // app.js가 부르는 계산 함수들 (web/engine.js와 같은 결과를 JSON 문자열로)
        @JavascriptInterface
        public String engineInit() {
            try {
                if (engine == null) {
                    Properties meta = new Properties();
                    try (InputStream in = getAssets().open("words/meta.txt")) {
                        meta.load(in);
                    }
                    engine = new Engine(meta, map("words.bin"), map("vectors.bin"), map("norms.bin"),
                            map("rankable.bin"), map("secrets.bin"));
                }
                return engine.init();
            } catch (Exception e) {
                return "{\"error\":\"" + e.getClass().getSimpleName() + "\"}";
            }
        }

        @JavascriptInterface
        public String engineStory(int puzzle) {
            return engine.story(puzzle);
        }

        @JavascriptInterface
        public String engineGuess(int puzzle, String word) {
            return engine.guess(puzzle, word);
        }

        @JavascriptInterface
        public String engineNearest(int puzzle) {
            return engine.nearestJson(puzzle);
        }

        @JavascriptInterface
        public String engineSecret(int puzzle) {
            return engine.secret(puzzle);
        }

        @JavascriptInterface
        public void share(String text) {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, text);
            runOnUiThread(() -> startActivity(Intent.createChooser(send, null)));
        }
    }
}
