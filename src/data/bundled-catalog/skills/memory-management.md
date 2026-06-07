---
id: memory-management
name: Memory Management
description: Detect and fix memory leaks, optimize memory usage, and implement efficient data structures
source: bundled
version: 1.0.0
category: optimization
tags: [memory, leaks, profiling, optimization]
scope: project
---

# Memory Management

Detect and fix memory leaks, optimize memory usage, and implement efficient data structures.

## When to Use
- When applications show increasing memory usage over time
- When profiling reveals memory-related performance issues
- When optimizing for memory-constrained environments
- When debugging out-of-memory crashes

## Guidelines

### Leak Detection
- Use heap snapshots to identify growing object counts
- Monitor memory usage trends over time
- Check for detached DOM nodes in browser applications
- Look for uncleaned event listeners and timers

### Common Leak Patterns
- Event listeners not removed on component unmount
- Closures capturing large objects unnecessarily
- Growing caches without eviction policies
- Circular references preventing garbage collection
- Global variables accumulating data

### Optimization Techniques
- Use WeakMap/WeakSet for cache entries that should be GC-eligible
- Implement object pooling for frequently created/destroyed objects
- Use streaming for large data processing instead of loading all into memory
- Choose appropriate data structures (Map vs Object, TypedArray vs Array)

### Profiling
- Take heap snapshots before and after operations
- Use allocation timeline to find allocation hotspots
- Compare snapshots to identify retained objects
- Profile in production-like conditions

## Best Practices
- Set memory budgets and monitor in production
- Add memory leak tests for long-running processes
- Clean up resources in component lifecycle hooks
- Review memory impact when adding new dependencies
