/**
 * Deployment readiness module — validates all aspects of deployment
 * including artifacts, migrations, rollback procedures, monitoring,
 * and authorization before any production release.
 *
 * Requirements: 39.1, 39.2, 39.3, 39.4, 39.5, 39.6, 39.7, 39.8, 39.9
 */

export * from './types';
export {
  DeploymentReadinessService,
  AuthorizationRequiredError,
  MissingMandatoryDataError,
  BreakingChangeRequiresNotesError,
  MigrationValidationError,
  MANDATORY_GATE_CATEGORIES,
  type BreakingChangeDetector,
  type ArtifactResolver,
  type MigrationDetector,
  type HealthCheckExecutor,
  type SmokeTestRunner,
  type ErrorRateCollector,
} from './deployment-readiness-service';
