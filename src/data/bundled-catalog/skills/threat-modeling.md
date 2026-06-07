---
id: threat-modeling
name: Threat Modeling
description: Systematically identify and mitigate security threats using STRIDE and attack tree methodologies
source: bundled
version: 1.0.0
category: security
tags: [security, threat-modeling, stride, risk]
scope: project
---

# Threat Modeling

Systematically identify and mitigate security threats using STRIDE methodology and attack tree analysis.

## When to Use
- During system design before implementation begins
- When adding new features that handle sensitive data
- When integrating with external systems or APIs
- During periodic security architecture reviews

## Guidelines

### STRIDE Analysis
- Spoofing: Can an attacker impersonate a user or system?
- Tampering: Can data be modified in transit or at rest?
- Repudiation: Can actions be denied without audit trails?
- Information Disclosure: Can sensitive data leak?
- Denial of Service: Can the system be overwhelmed?
- Elevation of Privilege: Can users gain unauthorized access?

### Process
1. Diagram the system with data flows and trust boundaries
2. Identify assets worth protecting
3. Enumerate threats using STRIDE per component
4. Rate threats by likelihood and impact
5. Define mitigations for each threat
6. Verify mitigations are implemented

### Trust Boundaries
- Mark boundaries between user input and server processing
- Identify boundaries between internal services
- Map boundaries between your system and third parties
- Document authentication requirements at each boundary

### Risk Rating
- Use DREAD or CVSS for consistent severity scoring
- Consider both technical impact and business impact
- Factor in exploitability and discoverability
- Prioritize mitigations by risk score

## Best Practices
- Involve developers, security, and product in threat modeling sessions
- Update threat models when architecture changes
- Track threats as issues alongside feature work
- Use threat models to inform security testing priorities
