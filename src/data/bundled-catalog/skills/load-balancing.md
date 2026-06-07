---
id: load-balancing
name: Load Balancing
description: Distribute traffic across services with intelligent routing and health-aware algorithms
source: bundled
version: 1.0.0
category: infrastructure
tags: [load-balancing, traffic, routing, health-checks, scaling]
scope: project
---

# Load Balancing

## Algorithms

- **Round Robin**: Equal distribution, simple and predictable
- **Weighted Round Robin**: Distribute based on server capacity
- **Least Connections**: Route to the server with fewest active requests
- **IP Hash**: Consistent routing for session affinity
- **Latency-based**: Route to the fastest responding server

## Health Checks

- Active health checks: Periodic probes to each backend
- Passive health checks: Monitor response codes and latency
- Graceful removal: Drain connections before marking unhealthy
- Recovery detection: Gradually reintroduce recovered backends

## Layer 4 vs Layer 7

- **L4 (TCP/UDP)**: Fast, protocol-agnostic, limited routing options
- **L7 (HTTP)**: Content-based routing, header inspection, SSL termination
- Choose L4 for raw throughput, L7 for intelligent routing

## Scaling Considerations

- Use auto-scaling groups behind load balancers
- Configure connection draining for graceful scale-down
- Set appropriate timeouts for long-running requests
- Monitor backend saturation to trigger scaling events
