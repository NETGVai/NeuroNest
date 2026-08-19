// @ts-nocheck
/**
 * Chat Theming — NeuroNest Identity
 *
 * Injects CSS overrides that enhance the existing chat UI elements with
 * polished visual design matching the app's identity. All rendered-content
 * colors reference semantic tokens defined in semantic-tokens.css so a
 * theme revision applies here through variable resolution alone.
 *
 * Requirements: 14.1–14.3 (Theme System), 24.1–24.9 (Chat Identity)
 */
(function chatThemingInit() {
  var style = document.createElement('style');
  style.id = 'neuronest-chat-theming';
  style.textContent = `
    /* Plain, theme-token background across every chat/main surface. */
    #main-content,
    #chat-view,
    #chat-area {
      background-color: var(--bg-primary) !important;
      background-image: none !important;
      background-size: auto !important;
      background-blend-mode: normal !important;
    }

    /* ── 24.1: User messages — accent background, on-accent text, rounded, drop shadow ── */
    .message.user .message-inner {
      background: var(--accent) !important;
      color: var(--nn-color-on-accent) !important;
      border-radius: var(--radius) !important;
      border: none !important;
      box-shadow: var(--shadow-md, var(--shadow-sm)) !important;
    }
    .message.user .message-body,
    .message.user .role-label {
      color: var(--nn-color-on-accent) !important;
    }

    /* ── 24.2: Agent messages — surface-container-high background, border ── */
    .message.assistant .message-inner {
      background: var(--surface-container-high) !important;
      color: var(--nn-color-content-fg) !important;
      border: 1px solid var(--nn-color-border-subtle) !important;
      border-radius: var(--radius) !important;
      box-shadow: none !important;
    }
    .message.assistant .message-body {
      color: var(--nn-color-content-fg) !important;
    }

    /* Code blocks sit one surface level above their parent response card.
       This creates a restrained contrast step in every theme without using
       hard-coded dark/light colors. */
    .message.assistant .message-body .code-block-wrapper {
      background-color: var(--surface-container-highest, var(--bg-input)) !important;
      border-color: var(--outline, var(--nn-color-code-border)) !important;
      box-shadow: inset 0 1px 0 var(--surface-hover), var(--shadow-sm, none);
    }
    .message.assistant .message-body .code-block-header {
      background-color: var(--surface-container, var(--nn-color-code-header-bg)) !important;
      border-bottom-color: var(--outline-variant, var(--nn-color-code-border)) !important;
    }
    .message.assistant .message-body .code-block-wrapper pre.code-block-pre {
      background-color: transparent !important;
    }

    /* Light-surface themes require an explicitly dark command foreground.
       Semantic foreground tokens can be accent-derived in these themes, so
       use each theme's primary text token for skill/status command cards. */
    body.theme-light .message.command-result .message-body,
    body.theme-sepia .message.command-result .message-body,
    body.theme-zen .message.command-result .message-body,
    .theme-light .message.command-result .message-body,
    .theme-sepia .message.command-result .message-body,
    .theme-zen .message.command-result .message-body {
      color: var(--text-primary) !important;
    }
    body.theme-light .message.command-result .message-body strong,
    body.theme-light .message.command-result .message-body b,
    body.theme-sepia .message.command-result .message-body strong,
    body.theme-sepia .message.command-result .message-body b,
    body.theme-zen .message.command-result .message-body strong,
    body.theme-zen .message.command-result .message-body b,
    .theme-light .message.command-result .message-body strong,
    .theme-light .message.command-result .message-body b,
    .theme-sepia .message.command-result .message-body strong,
    .theme-sepia .message.command-result .message-body b,
    .theme-zen .message.command-result .message-body strong,
    .theme-zen .message.command-result .message-body b {
      color: var(--text-primary) !important;
      -webkit-text-fill-color: var(--text-primary) !important;
    }
    body.theme-light .message.command-result .role-label,
    body.theme-sepia .message.command-result .role-label,
    body.theme-zen .message.command-result .role-label,
    .theme-light .message.command-result .role-label,
    .theme-sepia .message.command-result .role-label,
    .theme-zen .message.command-result .role-label {
      color: var(--accent) !important;
      font-weight: 650;
    }

    /* ── 24.4: Message transitions — fade-in on new messages ── */
    .message {
      animation: chatMsgFadeIn var(--motion-standard) ease-out both;
    }
    @keyframes chatMsgFadeIn {
      from {
        opacity: 0;
        transform: translateY(8px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    /* ── 24.5: Typing indicator — 3 bouncing dots in accent color ── */
    .typing-indicator span {
      background: var(--accent) !important;
    }

    /* ── 24.6: Timestamps — text-dim, 10px, below messages ── */
    .message-timestamp {
      display: block;
      font-size: 10px;
      color: var(--nn-color-content-fg-dim);
      margin-top: 4px;
      line-height: 1.4;
    }
    .message.user .message-timestamp {
      text-align: right;
      color: var(--nn-color-on-accent-muted);
    }

    /* ── 24.7: Avatar indicators ── */
    /* User avatar: initial in accent circle */
    .message.user .message-avatar {
      background: var(--accent) !important;
      color: var(--nn-color-on-accent) !important;
      font-size: 12px !important;
      font-weight: 700 !important;
      border-radius: 50% !important;
      width: 28px !important;
      height: 28px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      box-shadow: var(--shadow-sm);
    }
    /* Agent avatar: brain emoji in surface-container-highest circle */
    .message.assistant .message-avatar {
      background: var(--surface-container-highest) !important;
      border-radius: 50% !important;
      width: 28px !important;
      height: 28px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      font-size: 16px !important;
      border: 1px solid var(--nn-color-border-subtle);
    }

    /* ── 24.8: Input area — top border, padding, accent send button ── */
    #input-bar {
      border-top: 1px solid var(--nn-color-border-subtle);
      padding: 8px 16px 12px !important;
    }
    #send-btn {
      background: var(--accent) !important;
      color: var(--nn-color-on-accent) !important;
    }
    #send-btn:hover {
      background: var(--accent-hover) !important;
    }

    /* ── 24.9: Focus glow on input — accent-tinted glow via token ── */
    #input-wrapper:focus-within {
      border-color: var(--nn-color-focus-ring) !important;
      box-shadow: 0 0 0 3px var(--nn-color-focus-glow) !important;
    }

    /* ── Reduced-motion overrides (Requirement 14.8) ──
       Disable message fade-in transitions and hover transforms when
       the OS reports "prefers-reduced-motion: reduce". State meaning is
       preserved through the same text and icons; only motion is dropped. */
    @media (prefers-reduced-motion: reduce) {
      .message {
        animation: none !important;
      }

      #input-wrapper,
      #send-btn,
      .message.user .message-avatar {
        transition: none !important;
      }
    }
  `;
  document.head.appendChild(style);
})();
