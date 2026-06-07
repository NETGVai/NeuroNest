---
id: zero-trust-security
name: Zero Trust Security
description: Implement zero-trust architecture with identity verification, least privilege, and continuous validation
source: bundled
version: 1.0.0
category: security
tags: [security, zero-trust, identity, access-control]
scope: project
---

# Zero Trust Security

Implement zero-trust architecture principles: never trust, always verify, enforce least privilege.

## When to Use
- When designing authentication and authorization systems
- When securing microservice-to-service communication
- When implementing network segmentation
- When hardening API access controls

## Guidelines

### Core Principles
- Verify explicitly: authenticate and authorize every request
- Least privilege: grant minimum permissions needed
- Assume breach: design as if the network is compromised
- Continuous validation: re-verify trust on every access

### Identity and Access
- Use strong authentication (MFA, passkeys, certificates)
- Implement fine-grained RBAC or ABAC policies
- Issue short-lived tokens and rotate credentials
- Audit all access decisions and denials

### Service-to-Service Security
- Use mutual TLS (mTLS) between services
- Implement service identity with SPIFFE/SPIRE or similar
- Validate service tokens on every request
- Encrypt all internal communication

### Network Security
- Segment networks by sensitivity level
- Use micro-segmentation for service isolation
- Implement egress filtering to prevent data exfiltration
- Monitor lateral movement patterns

## Best Practices
- Start with identity as the new perimeter
- Log all authentication and authorization events
- Implement automated policy enforcement
- Test security controls with regular penetration testing
