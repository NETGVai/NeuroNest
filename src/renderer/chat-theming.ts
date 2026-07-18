// @ts-nocheck
/**
 * Chat Theming — NeuroNest Identity
 * Injects CSS overrides that enhance the existing chat UI elements
 * with polished visual design matching the app's identity.
 *
 * Requirements: 24.1-24.9
 */
(function chatThemingInit() {
  var style = document.createElement('style');
  style.id = 'neuronest-chat-theming';
  style.textContent = `
    /* ── 24.3: Chat area background — subtle grid pattern at 2% opacity ── */
    #chat-area {
      background-color: var(--bg-primary);
      background-image:
        linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
      background-size: 24px 24px;
    }

    /* ── 24.1: User messages — accent background, white text, rounded corners, shadow ── */
    .message.user .message-inner {
      background: var(--accent) !important;
      color: #ffffff !important;
      border-radius: var(--radius) !important;
      border: none !important;
      box-shadow: 0 2px 8px rgba(0, 122, 255, 0.25), 0 1px 3px rgba(0,0,0,0.15) !important;
    }
    .message.user .message-body,
    .message.user .role-label {
      color: #ffffff !important;
    }

    /* ── 24.2: Agent messages — surface-container-high background, border ── */
    .message.assistant .message-inner {
      background: var(--surface-container-high) !important;
      color: var(--text-primary) !important;
      border: 1px solid var(--border-color) !important;
      border-radius: var(--radius) !important;
      box-shadow: none !important;
    }
    .message.assistant .message-body {
      color: var(--text-primary) !important;
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
      color: var(--text-dim);
      margin-top: 4px;
      line-height: 1.4;
    }
    .message.user .message-timestamp {
      text-align: right;
      color: rgba(255,255,255,0.55);
    }

    /* ── 24.7: Avatar indicators ── */
    /* User avatar: initial in accent circle */
    .message.user .message-avatar {
      background: var(--accent) !important;
      color: #ffffff !important;
      font-size: 12px !important;
      font-weight: 700 !important;
      border-radius: 50% !important;
      width: 28px !important;
      height: 28px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      box-shadow: 0 1px 4px rgba(0, 122, 255, 0.3);
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
      border: 1px solid var(--border-color);
    }

    /* ── 24.8: Input area — top border, padding, accent send button ── */
    #input-bar {
      border-top: 1px solid var(--border-color);
      padding: 8px 16px 12px !important;
    }
    #send-btn {
      background: var(--accent) !important;
      color: #ffffff !important;
    }
    #send-btn:hover {
      background: var(--accent-hover) !important;
    }

    /* ── 24.9: Focus glow on input — accent box-shadow at 0.15 opacity ── */
    #input-wrapper:focus-within {
      border-color: var(--accent) !important;
      box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.15) !important;
    }
  `;
  document.head.appendChild(style);
})();
