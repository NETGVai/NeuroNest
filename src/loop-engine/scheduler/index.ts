// ─── Loop Scheduler ─────────────────────────────────────────────
// Cross-platform scheduler for unattended loop execution.
// Supports macOS launchd, Linux systemd, Windows Task Scheduler.

export { LoopScheduler } from './loop-scheduler.js';
export type { FeatureGateCheckLike, KillSwitchLike, LoopSchedulerDeps } from './loop-scheduler.js';
