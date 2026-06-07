---
id: css-architecture
name: CSS Architecture
description: Design scalable CSS architectures with modern layout, design tokens, and component-scoped styles
source: bundled
version: 1.0.0
category: frontend
tags: [css, design-system, layout, responsive]
scope: project
---

# CSS Architecture

Design scalable CSS architectures with modern layout techniques, design tokens, and component-scoped styles.

## When to Use
- When establishing a new project's styling foundation
- When refactoring legacy CSS into a maintainable system
- When building or extending a design system

## Guidelines

### Design Tokens
- Define spacing, color, typography, and shadow scales as CSS custom properties
- Use semantic token names (--color-primary, --space-md)
- Support dark/light themes via token swapping
- Document token usage with examples

### Layout Patterns
- Use CSS Grid for two-dimensional layouts
- Use Flexbox for one-dimensional alignment
- Implement responsive designs with container queries where supported
- Use logical properties (inline/block) for internationalization

### Component Styling
- Scope styles to components using CSS Modules or scoped styles
- Avoid deep selector nesting (max 3 levels)
- Use BEM or utility-first conventions consistently
- Minimize use of `!important`

### Performance
- Minimize CSS bundle size by removing unused styles
- Use `content-visibility` for off-screen content
- Prefer CSS animations over JavaScript for simple transitions
- Avoid layout thrashing with `will-change` hints

## Best Practices
- Establish a single source of truth for design tokens
- Use a CSS reset or normalize for cross-browser consistency
- Test responsive layouts across breakpoints and devices
- Document component variants and states in a style guide
