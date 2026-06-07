/**
 * Detect whether the app was launched in CLI mode (from terminal)
 * or GUI mode (from Dock/Finder).
 */
export function getLaunchMode(): 'gui' | 'cli' {
  const args = process.argv.slice(1);
  if (args.includes('--cli')) {
    return 'cli';
  }
  return 'gui';
}
