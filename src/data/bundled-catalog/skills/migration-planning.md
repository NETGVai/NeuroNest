---
id: migration-planning
name: Migration Planning
description: Plan database and system migrations with rollback strategies and zero-downtime approaches
source: bundled
version: 1.0.0
category: database
tags: [migration, database, zero-downtime, rollback, planning]
scope: project
---

# Migration Planning

## Migration Types

- **Schema migrations**: Column additions, type changes, index creation
- **Data migrations**: Transforming or backfilling existing data
- **Platform migrations**: Moving between cloud providers or services
- **Framework migrations**: Upgrading or replacing core dependencies

## Zero-Downtime Migration Pattern

1. Deploy code that handles both old and new schemas
2. Run migration to add new columns/tables (additive only)
3. Backfill data into new structures
4. Switch reads to new structures
5. Remove old columns/tables in a later release

## Rollback Strategy

- Every migration must have a corresponding rollback script
- Test rollback in staging before production execution
- Set clear go/no-go criteria before starting
- Keep a communication plan for stakeholders during migration

## Data Validation

- Compare row counts before and after migration
- Spot-check data integrity on sample records
- Run application-level validation tests post-migration
- Monitor error rates closely for 24-48 hours after completion
