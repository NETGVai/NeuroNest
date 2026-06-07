---
id: data-modeling
name: Data Modeling
description: Design effective data models for relational, document, and graph databases
source: bundled
version: 1.0.0
category: data
tags: [data-modeling, schema, nosql, graph]
scope: project
---

# Data Modeling

Design effective data models for relational, document, and graph databases that balance performance, integrity, and flexibility.

## When to Use
- When designing a new database schema from requirements
- When choosing between SQL and NoSQL for a use case
- When modeling complex domain relationships
- When optimizing data access patterns

## Guidelines

### Relational Modeling
- Start with entity-relationship diagrams
- Normalize to eliminate redundancy (3NF minimum)
- Define primary keys, foreign keys, and constraints
- Use junction tables for many-to-many relationships

### Document Modeling (MongoDB, DynamoDB)
- Model based on access patterns, not entity relationships
- Embed related data that is always accessed together
- Reference data that changes independently or is shared
- Design partition keys for even data distribution

### Graph Modeling
- Identify entities as nodes and relationships as edges
- Store properties on both nodes and edges
- Model traversal patterns for common queries
- Use labels and types for categorization

### Data Evolution
- Plan for schema changes from the start
- Use migration tools for versioned schema changes
- Support backward compatibility during transitions
- Document data lineage and transformation rules

## Best Practices
- Validate models against actual query patterns before implementation
- Include audit fields (created_at, updated_at) on all tables
- Use soft deletes for data that may need recovery
- Test with realistic data volumes during design
