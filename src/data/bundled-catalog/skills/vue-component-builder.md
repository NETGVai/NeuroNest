---
id: vue-component-builder
name: Vue Component Builder
description: Build production-ready Vue 3 components with Composition API, TypeScript, and reactive patterns
source: bundled
version: 1.0.0
category: frontend
tags: [vue, typescript, composition-api, components]
scope: project
---

# Vue Component Builder

Build production-ready Vue 3 components with Composition API, TypeScript, and reactive patterns.

## When to Use
- When building new Vue 3 components or migrating from Options API
- When creating reusable component libraries
- When implementing complex reactive state patterns

## Guidelines

### Component Structure
- Use `<script setup>` with TypeScript for concise components
- Define props with `defineProps<T>()` for type safety
- Use `defineEmits<T>()` for typed event emission
- Organize template, script, and style in Single File Components

### Composition API Patterns
- Extract reusable logic into composables (`use*` functions)
- Use `ref()` for primitives, `reactive()` for objects
- Leverage `computed()` for derived state
- Use `watch()` and `watchEffect()` for side effects

### State Management
- Use Pinia for global state management
- Keep component state local when possible
- Use `provide/inject` for dependency injection in component trees

### Performance
- Use `v-memo` for expensive list rendering
- Lazy-load components with `defineAsyncComponent`
- Use `shallowRef` when deep reactivity is unnecessary

## Best Practices
- Keep components focused on a single responsibility
- Use slots for flexible content composition
- Write unit tests with Vue Test Utils
- Follow Vue style guide naming conventions
