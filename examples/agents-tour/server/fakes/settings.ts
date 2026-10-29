/**
 * @module
 * What the fake Slack and the fake GitHub agree on: the people, the channels
 * and the repositories.
 */

// The Slack channels the agents may post in.
export const slackChannels = ["C01GENERAL", "C02ENG", "C03SUPPORT"];

// The repositories the agents may touch.
export const githubRepos = ["acme/web", "acme/api", "acme/docs"];

// The Slack bot, and the person who types in the tour.
export const botUser = "U00BOT";
export const botId = "B00BOT";
export const humanUser = "U01YOU";

// The login the agents act as on GitHub, and the person's own.
export const botLogin = "tour-bot";
export const humanLogin = "you";
