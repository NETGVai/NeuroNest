---
id: auth-patterns
name: Authentication Patterns
description: Implement authentication flows including OAuth, SAML, passkeys, and session management
source: bundled
version: 1.0.0
category: security
tags: [authentication, oauth, saml, passkeys, sessions]
scope: project
---

# Authentication Patterns

## OAuth 2.0 Flows

- **Authorization Code + PKCE**: Best for SPAs and mobile apps
- **Client Credentials**: Machine-to-machine authentication
- **Device Code**: For input-constrained devices (TVs, CLIs)
- Never use Implicit flow — it's deprecated for security reasons

## Session Management

- Use secure, HttpOnly, SameSite cookies for session tokens
- Implement session rotation on privilege escalation
- Set appropriate session timeouts (idle and absolute)
- Store sessions server-side with Redis or database backing

## Passkeys / WebAuthn

- Phishing-resistant, passwordless authentication
- Use platform authenticators (Touch ID, Windows Hello)
- Support cross-device authentication via hybrid transport
- Store public keys server-side, private keys never leave device

## Token Best Practices

- Keep access tokens short-lived (5-15 minutes)
- Use refresh tokens with rotation and reuse detection
- Include minimal claims in JWTs to reduce token size
- Validate tokens on every request, check expiry and issuer
