/**
 * `waitUntil` — extends a Vercel Function's lifetime to complete a background
 * promise without holding the HTTP response open. Uses @vercel/functions'
 * built-in handler when running on Vercel Fluid Compute; falls back to a
 * rejection-swallowing runner otherwise (local dev).
 */
import { waitUntil as vercelWaitUntil } from '@vercel/functions';

export function waitUntil(promise: Promise<unknown>): void {
  try {
    vercelWaitUntil(promise);
  } catch {
    // Not running on Vercel (local dev). Let the promise run loose but catch
    // rejections so Node doesn't crash the process.
    promise.catch((err) => {
      console.error('[scanner] waitUntil local-fallback caught:', err);
    });
  }
}
