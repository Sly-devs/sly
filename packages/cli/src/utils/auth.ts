import { Sly } from '@sly_ai/sdk';

export function createClient(): Sly {
  const apiKey = process.env.SLY_API_KEY;
  if (!apiKey) {
    console.error('Error: SLY_API_KEY environment variable is required');
    console.error('Set it with: export SLY_API_KEY=pk_test_...');
    process.exit(1);
  }
  return new Sly({
    apiKey,
    apiUrl: process.env.SLY_API_URL,
  });
}
