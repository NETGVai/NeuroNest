/**
 * Cross-Platform Emoji Renderer
 *
 * Replaces native Unicode emoji with Twemoji SVG images so they look
 * identical on macOS, Windows, and Linux. Uses the jsDelivr CDN for
 * Twemoji SVGs (no local bundle needed).
 *
 * Usage: call `initEmojiRenderer()` once on page load, then all emoji
 * in the DOM (and future mutations) will be rendered as SVGs.
 */

(function() {
  'use strict';

  // Local Twemoji SVG path (bundled with the app — no network dependency)
  var TWEMOJI_BASE = './twemoji/';

  // Regex to match emoji characters (covers most common emoji)
  // This is a simplified pattern — covers Emoji_Presentation characters
  var EMOJI_REGEX = /(?:\ud83d[\ude00-\udeff]|\ud83c[\udf00-\udfff]|\ud83e[\udd00-\uddff]|\ud83d[\udc00-\udcff]|\ud83d[\ude80-\udeff]|\u2600-\u27bf|\ufe0f|\u200d|\u2764|\u2728|\u26a0|\u2699|\u2705|\u274c|\u2934|\u2935|\ud83d[\udd00-\uddff]|\u23f0-\u23ff|\u2b50|\u2b55|\u2139|\u2194-\u21aa|\u231a-\u231b|\u25aa-\u25fe|\u2600-\u26ff|\u2702-\u27bf|\ud83c[\ude00-\udeff])/gu;

  /**
   * Convert a single emoji character to its Twemoji SVG URL.
   * Returns null if the codepoint doesn't map to a valid Twemoji file.
   */
  function emojiToUrl(emoji) {
    var codepoints = [];
    for (var i = 0; i < emoji.length; i++) {
      var code = emoji.codePointAt(i);
      if (code > 0xFFFF) i++; // Skip surrogate pair
      // Skip variation selectors (FE0F) and zero-width joiners (200D) for the filename
      if (code === 0xFE0F) continue;
      codepoints.push(code.toString(16));
    }
    if (codepoints.length === 0) return null;
    return TWEMOJI_BASE + codepoints.join('-') + '.svg';
  }

  /**
   * Replace emoji in a text node with <img> elements pointing to Twemoji SVGs.
   */
  function replaceEmojiInTextNode(textNode) {
    var text = textNode.nodeValue;
    if (!text) return;

    // Quick check — skip if no emoji-like characters
    if (!/[\u2000-\u3300]|[\ud83c-\ud83e]/.test(text)) return;

    var parts = [];
    var lastIndex = 0;
    var match;

    // Reset regex
    EMOJI_REGEX.lastIndex = 0;

    while ((match = EMOJI_REGEX.exec(text)) !== null) {
      var emoji = match[0];
      var url = emojiToUrl(emoji);
      if (!url) continue;

      // Text before the emoji
      if (match.index > lastIndex) {
        parts.push(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      // Create img element for the emoji
      var img = document.createElement('img');
      img.className = 'twemoji';
      img.alt = emoji;
      img.src = url;
      img.draggable = false;
      // If local SVG doesn't exist, hide the broken image and show the native emoji
      img.onerror = function() { this.style.display = 'none'; this.insertAdjacentText('afterend', emoji); };
      parts.push(img);

      lastIndex = match.index + emoji.length;
    }

    if (parts.length === 0) return; // No emoji found

    // Remaining text after last emoji
    if (lastIndex < text.length) {
      parts.push(document.createTextNode(text.slice(lastIndex)));
    }

    // Replace the text node with the parts
    var parent = textNode.parentNode;
    if (!parent) return;

    var fragment = document.createDocumentFragment();
    for (var i = 0; i < parts.length; i++) {
      fragment.appendChild(parts[i]);
    }
    parent.replaceChild(fragment, textNode);
  }

  /**
   * Process all text nodes within an element, replacing emoji with SVG images.
   */
  function processElement(el) {
    if (!el || el.nodeType !== 1) return;

    // Skip elements that shouldn't have emoji replaced
    var tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'CODE' || tag === 'PRE') return;

    // Skip elements already processed
    if (el.getAttribute('data-twemoji') === 'done') return;

    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    var textNodes = [];
    var node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }

    for (var i = 0; i < textNodes.length; i++) {
      replaceEmojiInTextNode(textNodes[i]);
    }
  }

  /**
   * Initialize the emoji renderer.
   * - Processes all existing emoji in the DOM
   * - Sets up a MutationObserver to handle dynamically added content
   */
  function initEmojiRenderer() {
    // Add CSS for twemoji images
    var style = document.createElement('style');
    style.textContent = '.twemoji { height: 1.2em; width: 1.2em; vertical-align: -0.2em; display: inline-block; margin: 0 0.05em; }';
    document.head.appendChild(style);

    // Process existing content
    processElement(document.body);

    // Watch for new content (chat messages, dynamic UI)
    var observer = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i];
        for (var j = 0; j < mutation.addedNodes.length; j++) {
          var node = mutation.addedNodes[j];
          if (node.nodeType === 1) {
            processElement(node);
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    console.log('[EmojiRenderer] Twemoji renderer initialized — emoji will render consistently across platforms');
  }

  // Export for use
  window.initEmojiRenderer = initEmojiRenderer;
  window.processEmojiInElement = processElement;
})();
