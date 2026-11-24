/**
 * @module
 * Type tests for skills.
 */
import { Inngest } from "../../../components/Inngest.ts";
import type { InputOf, OutputOf } from "../agent/typeFixtures.ts";
import { agents, created, typesOnly } from "../agent/typeFixtures.ts";
import * as entry from "../index.ts";
import { sandbox } from "../sandboxes/defs.ts";
import { createSkillTools, type Skill, skills } from "./skills.ts";

test("skills: an agent takes a folder source", () => {
  typesOnly(() => {
    agents.agent({
      id: "skills-1",
      triggers: [created],
      skills: [skills.folder("./skills")],
    });
    agents.agent({
      id: "skills-2",
      triggers: [created],
      skills: ({ event, thread }) => {
        expectTypeOf(event.name).toEqualTypeOf<"order/created">();
        expectTypeOf(thread).toEqualTypeOf<{ key: string }>();

        return [skills.folder("./skills")];
      },
    });

    // @ts-expect-error a skill source is not a path
    agents.agent({ id: "skills-3", triggers: [created], skills: ["./skills"] });
  });
});

test("skills: skills.git, skillsBake and the sandbox skills option are errors", () => {
  typesOnly(() => {
    // @ts-expect-error skills.git is gone
    void skills.git;

    // @ts-expect-error skillsBake is gone
    void entry.skillsBake;

    // @ts-expect-error a sandbox takes no skills option
    sandbox({ id: "no-skills", skills: [] });

    void new Inngest({ id: "types" });
  });
});

test("skills: open_skill takes a skill's name and gives its body", () => {
  const list: Skill[] = [];
  const tools = createSkillTools(list);

  expectTypeOf<InputOf<typeof tools.open_skill>>().toEqualTypeOf<{
    name: string;
  }>();
  expectTypeOf<OutputOf<typeof tools.open_skill>>().toEqualTypeOf<string>();
});
