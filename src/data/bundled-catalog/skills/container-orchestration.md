---
id: container-orchestration
name: Container Orchestration
description: Orchestrate containerized applications with Docker Compose, Kubernetes, and service mesh patterns
source: bundled
version: 1.0.0
category: devops
tags: [containers, docker, kubernetes, orchestration]
scope: project
---

# Container Orchestration

Orchestrate containerized applications with Docker Compose for development and Kubernetes for production.

## When to Use
- When deploying multi-container applications
- When managing service dependencies and networking
- When implementing auto-scaling and self-healing
- When standardizing deployment across environments

## Guidelines

### Docker Compose (Development)
- Define all services, networks, and volumes in docker-compose.yml
- Use environment-specific override files
- Mount source code as volumes for hot reload
- Use health checks for dependency ordering

### Kubernetes (Production)
- Use Deployments for stateless workloads
- Use StatefulSets for databases and stateful services
- Configure resource requests and limits for every container
- Implement liveness, readiness, and startup probes

### Networking
- Use Services for internal communication
- Configure Ingress for external traffic routing
- Implement NetworkPolicies for pod-to-pod security
- Use service mesh (Istio/Linkerd) for advanced traffic management

### Scaling and Reliability
- Configure Horizontal Pod Autoscaler based on CPU/memory/custom metrics
- Use Pod Disruption Budgets for safe maintenance
- Implement rolling updates with maxSurge and maxUnavailable
- Set up cluster autoscaling for node-level scaling

## Best Practices
- Use namespaces to isolate environments and teams
- Store configuration in ConfigMaps and secrets in Secrets
- Use Helm or Kustomize for templating and environment management
- Monitor cluster health with Prometheus and Grafana
