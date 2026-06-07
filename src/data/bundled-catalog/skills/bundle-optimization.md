---
id: bundle-optimization
name: Bundle Optimization
description: Optimize JavaScript bundle size with code splitting, tree shaking, and lazy loading
source: bundled
version: 1.0.0
category: optimization
tags: [bundle, webpack, vite, tree-shaking]
scope: project
---

# Bundle Optimization

Optimize JavaScript bundle size with code splitting, tree shaking, and lazy loading for faster page loads.

## When to Use
- When initial page load is slow due to large bundles
- When analyzing and reducing JavaScript payload size
- When configuring build tools for optimal output
- When implementing code splitting strategies

## Guidelines

### Analysis
- Use bundle analyzers (webpack-bundle-analyzer, source-map-explorer)
- Identify the largest dependencies and their usage
- Check for duplicate packages in the dependency tree
- Measure impact of each optimization with before/after comparisons

### Code Splitting
- Split by route for page-level lazy loading
- Split vendor code from application code
- Use dynamic imports for conditionally loaded features
- Set appropriate chunk naming for cache optimization

### Tree Shaking
- Use ES modules (import/export) for tree-shakeable code
- Avoid side effects in module scope
- Mark packages as side-effect-free in package.json
- Check that build tools are configured for tree shaking

### Lazy Loading
- Lazy load below-the-fold components
- Use Intersection Observer for scroll-triggered loading
- Implement loading states for lazy-loaded content
- Preload critical resources with link rel="preload"

## Best Practices
- Set bundle size budgets and enforce in CI
- Monitor bundle size trends over time
- Prefer smaller, focused libraries over large frameworks
- Use compression (gzip/brotli) for all served assets
