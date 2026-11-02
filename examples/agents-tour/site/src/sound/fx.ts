/**
 * @module
 * What the page does on top of a sound: confetti for Quest, a scanline flash
 * for Chiptune, a ripple from the speaker for Kalimba, and a shake with a red
 * edge for Doom. Only on payoffs and failures, and none of it under reduced
 * motion.
 */
import type { Fx } from "./styles.ts";

const calm = () => {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

const layer = () => {
  let host = document.getElementById("sound-fx");

  if (!host) {
    host = document.createElement("div");
    host.id = "sound-fx";
    host.setAttribute("aria-hidden", "true");
    document.body.append(host);
  }

  return host;
};

/**
 * Shakes the whole page for a moment.
 */
export const shake = () => {
  const app = document.querySelector<HTMLElement>(".app");

  if (!app || !calm()) {
    return;
  }

  app.classList.remove("shake");
  void app.offsetWidth;
  app.classList.add("shake");
};

const flash = (background: string, ms: number) => {
  const glow = document.createElement("div");

  glow.className = "sound-glow";
  glow.style.background = background;
  layer().append(glow);
  glow.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: ms,
    easing: "ease-out",
  }).onfinish = () => {
    glow.remove();
  };
};

/**
 * The red flash when the player takes damage.
 */
export const hurtFlash = () => {
  if (!calm()) {
    return;
  }

  flash("radial-gradient(circle, rgb(255 0 0 / 10%), rgb(200 0 0 / 55%))", 350);
  shake();
};

/**
 * The touch for a payoff or a failure in a style.
 */
export const visual = (fx: Fx, failed: boolean) => {
  if (!calm() || fx === "none") {
    return;
  }

  if (fx === "confetti" && !failed) {
    const colours = ["#7c7cff", "#3ecf8e", "#e0b04a", "#ff6b78", "#9b6bff"];

    for (let at = 0; at < 36; at++) {
      const bit = document.createElement("div");
      const angle = Math.random() * Math.PI * 2;
      const reach = 120 + Math.random() * 220;

      bit.className = "sound-bit";
      bit.style.background = colours[at % colours.length] ?? "#7c7cff";
      bit.style.left = "50%";
      bit.style.top = "35%";
      layer().append(bit);
      bit.animate(
        [
          { transform: "translate(0, 0) rotate(0)", opacity: 1 },
          {
            transform: `translate(${Math.cos(angle) * reach}px, ${Math.sin(angle) * reach + 160}px) rotate(${Math.random() * 540}deg)`,
            opacity: 0,
          },
        ],
        {
          duration: 900 + Math.random() * 400,
          easing: "cubic-bezier(.2, .7, .3, 1)",
        },
      ).onfinish = () => {
        bit.remove();
      };
    }
  } else if (fx === "shake") {
    shake();
    flash("radial-gradient(circle, transparent 40%, rgb(255 107 120 / 25%))", 180);
  } else if (fx === "scan") {
    flash(
      "repeating-linear-gradient(0deg, rgb(62 207 142 / 10%) 0 2px, transparent 2px 4px)",
      180,
    );
  } else if (fx === "ripple") {
    const ring = document.createElement("div");

    ring.className = "sound-ripple";
    layer().append(ring);
    ring.animate(
      [
        { transform: "scale(1)", opacity: 0.9 },
        { transform: "scale(30)", opacity: 0 },
      ],
      { duration: 900, easing: "ease-out" },
    ).onfinish = () => {
      ring.remove();
    };
  }
};
