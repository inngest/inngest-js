export const check = async (t: any) => {
  await t.send("idle", "a", "hi");
  await t.settle({ timeoutMs: 400 });
};
