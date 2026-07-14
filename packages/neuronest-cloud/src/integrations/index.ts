/**
 * Integrations — Chat and platform integrations barrel export
 *
 * Task 22.2
 */

export { SlackHandler, parseSlackCommand, verifySlackSignature } from './slack-handler';
export type { SlackCommand, SlackResponse, SlackHandlerConfig } from './slack-handler';

export { DiscordAdapter, verifyDiscordSignature } from './discord-adapter';
export type { DiscordInteraction, DiscordResponse, DiscordAdapterConfig } from './discord-adapter';
export { DiscordInteractionType, DiscordResponseType } from './discord-adapter';

export { GitHubIntegration, triageIssue, verifyGitHubSignature } from './github-integration';
export type {
  GitHubIssueEvent,
  GitHubPullRequestEvent,
  GitHubIntegrationConfig,
  IssueTriage,
  PRCreationRequest,
  CodeReviewTrigger,
} from './github-integration';
