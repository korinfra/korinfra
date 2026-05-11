/**
 * GitHub package — re-exports client and PR operations.
 */

export { GitHubClient } from './client.js';
export type { RateLimitInfo } from './client.js';
export {
  buildPRBody,
  createPR,
  addLabels,
  requestReviewers,
  readManifest,
  writeManifest,
} from './pr.js';
export type { PR, PROptions, PRRecommendation, korinfraManifest } from './pr.js';
