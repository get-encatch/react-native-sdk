/**
 * Inline WebView sizing helpers.
 *
 * Hosted form pages may constrain content to the WebView viewport (height:100%),
 * which prevents form:resize from reporting the true content height. Inject this
 * script after load so inline forms expand to their natural height and feel
 * embedded in the host page scroll view.
 */
export const INLINE_WEBVIEW_SIZING_FIX_SCRIPT = `
(function () {
  if (window.__encatchInlineSizingFixInstalled) {
    if (typeof window.__encatchMeasureInlineHeight === 'function') {
      window.__encatchMeasureInlineHeight();
    }
    return true;
  }
  window.__encatchInlineSizingFixInstalled = true;

  var STYLE_ID = 'encatch-inline-native-fix';
  if (!document.getElementById(STYLE_ID)) {
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      'html.encatch-inline-presentation,',
      'html.encatch-inline-presentation body {',
      '  height: auto !important;',
      '  min-height: 0 !important;',
      '  overflow: visible !important;',
      '}',
      'html.encatch-inline-presentation .app-container {',
      '  height: auto !important;',
      '  min-height: 0 !important;',
      '  overflow: visible !important;',
      '  justify-content: flex-start !important;',
      '  align-items: stretch !important;',
      '}',
      'html.encatch-inline-presentation .form-wrapper {',
      '  overflow: visible !important;',
      '}',
      'html.encatch-inline-presentation #encatch-form-id {',
      '  height: auto !important;',
      '  max-height: none !important;',
      '  min-height: 0 !important;',
      '  overflow: visible !important;',
      '}',
    ].join('\\n');
    document.head.appendChild(style);
  }

  document.documentElement.classList.add('encatch-inline-presentation');

  function measureInlineHeight() {
    var candidates = [
      document.querySelector('.form-wrapper'),
      document.getElementById('encatch-form-id'),
      document.querySelector('.app-container'),
      document.body,
    ].filter(Boolean);

    var height = 0;
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      height = Math.max(
        height,
        el.scrollHeight || 0,
        el.offsetHeight || 0,
        el.getBoundingClientRect ? el.getBoundingClientRect().height : 0
      );
    }

    height = Math.ceil(height);
    if (height > 0 && window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'form:resize',
        data: { height: height },
      }));
    }
    return height;
  }

  window.__encatchMeasureInlineHeight = measureInlineHeight;

  measureInlineHeight();
  requestAnimationFrame(measureInlineHeight);
  setTimeout(measureInlineHeight, 50);
  setTimeout(measureInlineHeight, 250);
  setTimeout(measureInlineHeight, 1000);

  if (typeof ResizeObserver !== 'undefined') {
    var target =
      document.querySelector('.form-wrapper') ||
      document.getElementById('encatch-form-id') ||
      document.querySelector('.app-container');
    if (target) {
      var observer = new ResizeObserver(function () {
        measureInlineHeight();
      });
      observer.observe(target);
      window.__encatchInlineResizeObserver = observer;
    }
  }

  return true;
})();
true;
`;

export function buildInlineWebViewSizingFixScript(): string {
  return INLINE_WEBVIEW_SIZING_FIX_SCRIPT;
}
