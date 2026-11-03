export const check = async (t: any) => {
  await t.send("idle", "a", "hi");
  await t.settle();
  await t.press("/slack/api/chat.postMessage", {
    channel: "C02ENG",
    text: "late",
  });

  const posts = await t.posts();

  if (posts.length !== 1 || posts[0].text !== "late") {
    t.fail(`Saw ${posts.length} posts.`);
  }
};
