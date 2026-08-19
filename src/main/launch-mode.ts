/**
 * Identifies how the application process was started.
 *
 * This is intentionally distinct from the graphical launch mode
 * (`classic` or `advanced`).
 */
export type ProcessLaunchKind = 'gui' | 'cli';

/**
 * Detect whether the app process was launched for the CLI (from a terminal)
 * or for the GUI (for example, from Dock/Finder).
 */
export function getProcessLaunchKind(): ProcessLaunchKind {
  const args = process.argv.slice(1);
  if (args.includes('--cli')) {
    return 'cli';
  }
  return 'gui';
}

/**
 * @deprecated Use getProcessLaunchKind() so this process-level distinction is
 * not confused with the graphical Classic/Advanced launch mode.
 */
export function getLaunchMode(): ProcessLaunchKind {
  return getProcessLaunchKind();
}
