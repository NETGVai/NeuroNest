---
id: cloud-cost-optimization
name: Cloud Cost Optimization
description: Optimize cloud infrastructure costs through right-sizing, reserved capacity, and resource management
source: bundled
version: 1.0.0
category: infrastructure
tags: [cloud, cost, optimization, aws]
scope: project
---

# Cloud Cost Optimization

Optimize cloud infrastructure costs through right-sizing, reserved capacity, and intelligent resource management.

## When to Use
- During monthly cloud spend reviews
- When provisioning new infrastructure
- When migrating workloads to the cloud
- When cloud costs exceed budget thresholds

## Guidelines

### Right-Sizing
- Analyze CPU and memory utilization over 2+ weeks
- Downsize over-provisioned instances
- Use burstable instances for variable workloads
- Match instance families to workload characteristics

### Reserved and Spot Capacity
- Use reserved instances for steady-state workloads (1-3 year terms)
- Use spot/preemptible instances for fault-tolerant batch jobs
- Implement savings plans for flexible compute commitments
- Mix on-demand, reserved, and spot for optimal cost

### Storage Optimization
- Implement lifecycle policies to tier data (hot → warm → cold → archive)
- Delete unused EBS volumes and snapshots
- Use appropriate storage classes (S3 Standard vs Infrequent Access vs Glacier)
- Compress and deduplicate stored data

### Operational Practices
- Tag all resources for cost allocation
- Set up billing alerts and budgets
- Schedule non-production resources to stop outside business hours
- Use serverless for intermittent workloads

## Best Practices
- Review costs weekly and set optimization targets
- Automate resource cleanup with infrastructure-as-code
- Use cloud provider cost management tools (AWS Cost Explorer, GCP Billing)
- Track cost per unit of business value, not just total spend
