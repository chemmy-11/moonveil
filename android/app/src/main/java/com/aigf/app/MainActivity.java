package com.aigf.app;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 配置 WebView 允许外部请求（DeepSeek API 直连）
        WebView webView = this.bridge.getWebView();
        if (webView != null) {
            WebSettings settings = webView.getSettings();
            settings.setAllowUniversalAccessFromFileURLs(true);
            settings.setAllowFileAccessFromFileURLs(true);
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowContentAccess(true);
        }

        // 键盘顶起适配：直接监听 ime insets（不依赖 adjustResize / opt-out，
        // 兼容 Android 15 强制 edge-to-edge 与 Android 16 移除 opt-out 的情况）。
        // 计算键盘实际遮挡高度并注入 CSS 变量 --kb-height，由 CSS 撑开页面底部。
        // 注意：WindowInsets 单位是物理像素，必须除以 density 转 CSS 像素，
        // 否则注入的 px 值会被 CSS 放大 dpr 倍（如 1095px ≈ 1.4 个屏幕高）。
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content), (v, insets) -> {
            int ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
            int nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom;
            int statusBar = insets.getInsets(WindowInsetsCompat.Type.statusBars()).top;
            final WebView wv = this.bridge.getWebView();
            if (wv != null) {
                final float density = wv.getResources().getDisplayMetrics().density;
                final int kbCss = Math.max(0, Math.round((ime - nav) / density));
                final int imeCss = Math.round(ime / density);
                final int navCss = Math.round(nav / density);
                // 真实状态栏高度（物理像素 → CSS 像素）：挖孔/刘海屏等机型高度各异，
                // 硬编码 28px 会遮挡内容，须按实际 insets 注入
                final int statusBarCss = Math.round(statusBar / density);
                wv.post(() -> wv.evaluateJavascript(
                    "document.documentElement.style.setProperty('--status-bar-h', '" + statusBarCss + "px');" +
                    "document.documentElement.style.setProperty('--kb-height', '" + kbCss + "px');" +
                    "document.documentElement.style.setProperty('--kb-ime', '" + imeCss + "px');" +
                    "document.documentElement.style.setProperty('--kb-nav', '" + navCss + "px');" +
                    "if (window.__onKbChange) window.__onKbChange(" + imeCss + "," + navCss + "," + kbCss + "); true",
                    null));
            }
            return insets;
        });
    }
}
