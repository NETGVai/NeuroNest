/**
 * Harness Health Widget component barrel export.
 *
 * Validates: Requirements 30.1, 30.2, 30.3, 30.4
 */

export { HarnessHealthWidget } from './harness-health-widget';
export {
  HARNESS_COMPONENTS,
  computeHarnessHealthState,
  isComponentPresent,
  getScaffoldActions,
  getNextScaffoldComponent,
  updateComponentStatus,
  setScaffolding,
  getHealthScore,
} from './harness-health-state';
export type {
  HarnessComponentId,
  HarnessComponentStatus,
  HarnessHealthState,
  HarnessHealthConfig,
  ComponentStatus,
  ScaffoldAction,
} from './types';
