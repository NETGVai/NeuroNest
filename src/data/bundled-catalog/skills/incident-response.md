---
id: incident-response
name: Incident Response
description: Handle production incidents with structured triage, root cause analysis, and post-mortem processes
source: bundled
version: 1.0.0
category: devops
tags: [incidents, on-call, post-mortem, reliability]
scope: project
---

# Incident Response

Handle production incidents with structured triage, root cause analysis, and blameless post-mortem processes.

## When to Use
- When responding to production outages or degradation
- When establishing incident response procedures
- When conducting post-incident reviews
- When improving system reliability after incidents

## Guidelines

### Triage
- Assess severity: critical (data loss, full outage), high (degraded), medium (partial), low (cosmetic)
- Identify affected users and business impact
- Assign incident commander and communication lead
- Start a shared incident channel for coordination

### Investigation
- Check monitoring dashboards for anomalies
- Review recent deployments and configuration changes
- Examine logs with correlation IDs
- Use distributed tracing to identify failing components

### Mitigation
- Prioritize restoring service over finding root cause
- Consider rollback, feature flag disable, or traffic rerouting
- Communicate status updates at regular intervals
- Document all actions taken during the incident

### Post-Mortem
- Write a blameless post-mortem within 48 hours
- Include timeline, root cause, impact, and action items
- Identify systemic improvements, not individual blame
- Track action items to completion

## Best Practices
- Practice incident response with game days
- Maintain up-to-date runbooks for common failure modes
- Set up on-call rotations with clear escalation paths
- Review incident trends quarterly to identify patterns
