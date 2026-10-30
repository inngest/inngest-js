/**
 * @module
 * Random but realistic things for the buttons to send, so a lesson never asks
 * the learner to type.
 */

export const pick = <T>(list: T[]) => {
  return list[Math.floor(Math.random() * list.length)] as T;
};

export const messages = [
  "Can you summarise today's incidents?",
  "What is the status of the checkout rollout?",
  "Remind me what we decided about retries.",
  "Draft a short update for the customer.",
  "Is the staging deploy healthy?",
  "Who is on call this week?",
];

export const replies = [
  "Thanks, can you also check the logs?",
  "That helps. What would you do next?",
  "Great, please go ahead.",
  "Can you make that shorter?",
];

export const names = ["Ada", "Grace", "Linus", "Margaret", "Alan", "Radia"];
