// @ts-nocheck
/**
 * Chat Scroll Controller — Smart scroll behavior for NeuroNest chat.
 * Requirements: 21.1-21.5
 *
 * - Auto-scroll only when user is within 100px of bottom
 * - "Jump to bottom" floating button with unread count when scrolled up
 * - Smooth scroll animation on button click
 * - Scroll position preservation across panel switches
 */
;(function () {
  var BOTTOM_THRESHOLD = 100;
  var unreadCount = 0;
  var isNearBottom = true;
  var jumpBtn = null;
  var badgeEl = null;
  var chatArea = null;
  var observer = null;
  var scrollPositions = {};
  var currentPanelId = 'chat';

  function init() {
    chatArea = document.getElementById('chat-area');
    if (!chatArea) return;

    createJumpButton();
    attachScrollListener();
    setupMutationObserver();
    setupIntersectionObserver();
    listenForPanelSwitches();
  }

  function createJumpButton() {
    jumpBtn = document.createElement('button');
    jumpBtn.className = 'chat-jump-bottom-btn';
    jumpBtn.setAttribute('aria-label', 'Jump to latest messages');
    jumpBtn.style.cssText = [
      'position: sticky',
      'bottom: 16px',
      'align-self: center',
      'display: none',
      'align-items: center',
      'gap: 6px',
      'padding: 8px 16px',
      'background: var(--accent, #007AFF)',
      'color: #fff',
      'border: none',
      'border-radius: 9999px',
      'font-size: 12px',
      'font-weight: 600',
      'cursor: pointer',
      'z-index: 50',
      'box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3)',
      'transition: all var(--motion-quick, 0.15s)',
      'font-family: inherit',
    ].join(';');

    jumpBtn.innerHTML = '<span style="font-size:14px;">&#8595;</span> <span class="jump-label">Jump to bottom</span>';

    badgeEl = document.createElement('span');
    badgeEl.className = 'chat-jump-badge';
    badgeEl.style.cssText = [
      'display: none',
      'align-items: center',
      'justify-content: center',
      'min-width: 18px',
      'height: 18px',
      'padding: 0 5px',
      'border-radius: 9px',
      'background: var(--red, #f87171)',
      'color: #fff',
      'font-size: 10px',
      'font-weight: 700',
      'line-height: 1',
    ].join(';');
    jumpBtn.appendChild(badgeEl);

    jumpBtn.addEventListener('click', function () {
      scrollToBottom(true);
      unreadCount = 0;
      updateBadge();
      hideJumpButton();
    });

    jumpBtn.addEventListener('mouseenter', function () {
      jumpBtn.style.transform = 'scale(1.05)';
    });
    jumpBtn.addEventListener('mouseleave', function () {
      jumpBtn.style.transform = 'scale(1)';
    });

    chatArea.appendChild(jumpBtn);
  }

  function attachScrollListener() {
    chatArea.addEventListener('scroll', function () {
      var scrollTop = chatArea.scrollTop;
      var scrollHeight = chatArea.scrollHeight;
      var clientHeight = chatArea.clientHeight;
      var distanceFromBottom = scrollHeight - scrollTop - clientHeight;

      isNearBottom = distanceFromBottom <= BOTTOM_THRESHOLD;

      if (isNearBottom) {
        unreadCount = 0;
        updateBadge();
        hideJumpButton();
      } else {
        showJumpButton();
      }
    }, { passive: true });
  }

  function setupMutationObserver() {
    var mutObs = new MutationObserver(function (mutations) {
      var hasNewMessages = false;
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i];
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (var j = 0; j < mutation.addedNodes.length; j++) {
            var node = mutation.addedNodes[j];
            if (node.nodeType === 1 && node.classList && node.classList.contains('message')) {
              hasNewMessages = true;
              break;
            }
          }
        }
        if (hasNewMessages) break;
      }

      if (hasNewMessages) {
        if (isNearBottom) {
          scrollToBottom(false);
        } else {
          unreadCount++;
          updateBadge();
          showJumpButton();
        }
        refreshIntersectionObserver();
      }
    });

    mutObs.observe(chatArea, { childList: true, subtree: false });
  }

  function setupIntersectionObserver() {
    observer = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          isNearBottom = true;
        }
      }
    }, {
      root: chatArea,
      threshold: 0.1,
    });

    refreshIntersectionObserver();
  }

  function refreshIntersectionObserver() {
    if (!observer) return;
    observer.disconnect();

    var messages = chatArea.querySelectorAll('.message');
    if (messages.length > 0) {
      var lastMessage = messages[messages.length - 1];
      if (lastMessage !== jumpBtn) {
        observer.observe(lastMessage);
      } else if (messages.length > 1) {
        observer.observe(messages[messages.length - 2]);
      }
    }
  }

  function scrollToBottom(smooth) {
    if (!chatArea) return;
    chatArea.scrollTo({
      top: chatArea.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
    isNearBottom = true;
  }

  function showJumpButton() {
    if (jumpBtn) {
      jumpBtn.style.display = 'inline-flex';
    }
  }

  function hideJumpButton() {
    if (jumpBtn) {
      jumpBtn.style.display = 'none';
    }
  }

  function updateBadge() {
    if (!badgeEl) return;
    if (unreadCount > 0) {
      badgeEl.style.display = 'inline-flex';
      badgeEl.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    } else {
      badgeEl.style.display = 'none';
      badgeEl.textContent = '';
    }
  }

  function listenForPanelSwitches() {
    // Save scroll position when navigating away from chat
    window.addEventListener('neuronest:panel-switch', function (e) {
      var detail = e.detail || {};
      if (currentPanelId === 'chat' && chatArea) {
        scrollPositions['chat'] = chatArea.scrollTop;
      }
      currentPanelId = detail.to || '';
    });

    // Restore scroll position when returning to chat
    window.addEventListener('neuronest:panel-restore', function (e) {
      var detail = e.detail || {};
      if (detail.panel === 'chat' && chatArea) {
        var saved = scrollPositions['chat'];
        if (typeof saved === 'number') {
          chatArea.scrollTop = saved;
        }
        currentPanelId = 'chat';
      }
    });

    // Fallback: observe visibility of main-content / chat-area
    var mainContent = document.getElementById('main-content');
    if (mainContent && typeof MutationObserver !== 'undefined') {
      var visObs = new MutationObserver(function () {
        if (chatArea && chatArea.offsetParent !== null) {
          var saved = scrollPositions['chat'];
          if (typeof saved === 'number' && currentPanelId === 'chat') {
            chatArea.scrollTop = saved;
          }
        }
      });
      visObs.observe(mainContent, { attributes: true, attributeFilter: ['style', 'class'] });
    }
  }

  // Expose for external use
  window.ChatScrollController = {
    scrollToBottom: scrollToBottom,
    savePosition: function () {
      if (chatArea) {
        scrollPositions['chat'] = chatArea.scrollTop;
      }
    },
    restorePosition: function () {
      if (chatArea) {
        var saved = scrollPositions['chat'];
        if (typeof saved === 'number') {
          chatArea.scrollTop = saved;
        }
      }
    },
    isAtBottom: function () {
      return isNearBottom;
    },
    getUnreadCount: function () {
      return unreadCount;
    },
  };

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
