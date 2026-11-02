/**
 * @module
 * What progress does on screen and to the rest of the site: concept pills
 * flying into the Concepts chip, and the moments other parts of the site
 * (sound, the style's visuals) listen for as `tour:moment` window events.
 * Reduced motion gets neither the flight nor the shake.
 */

const calm = () => {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

/**
 * Tells the site something happened, such as `moduleDone`.
 */
export const moment = (name: string) => {
  window.dispatchEvent(new CustomEvent("tour:moment", { detail: name }));
};

/**
 * Flies one pill per concept from the lesson text into the Concepts chip.
 */
export const flyConcepts = (names: string[]) => {
  const chip = document.getElementById("concepts-chip");
  const text = document.querySelector<HTMLElement>(".text");

  if (!chip || !text || !calm()) {
    return;
  }

  const to = chip.getBoundingClientRect();
  const from = text.getBoundingClientRect();

  names.forEach((name, at) => {
    const pill = document.createElement("span");

    pill.className = "pill flying";
    pill.textContent = name;
    pill.setAttribute("aria-hidden", "true");
    pill.style.left = `${from.left + 40 + at * 24}px`;
    pill.style.top = `${from.top + 120}px`;
    document.body.append(pill);

    const animation = pill.animate(
      [
        { transform: "translate(0, 0) scale(1)", opacity: 0 },
        {
          transform: "translate(0, -12px) scale(1.15)",
          opacity: 1,
          offset: 0.2,
        },
        {
          transform: `translate(${to.left + to.width / 2 - (from.left + 40 + at * 24)}px, ${to.top + to.height / 2 - (from.top + 120)}px) scale(0.5)`,
          opacity: 0.2,
        },
      ],
      { duration: 900, delay: at * 140, easing: "ease-in", fill: "both" },
    );

    animation.onfinish = () => {
      pill.remove();
      chip.animate(
        [
          { transform: "scale(1)" },
          { transform: "scale(1.08)" },
          { transform: "scale(1)" },
        ],
        { duration: 220 },
      );
    };
  });
};
