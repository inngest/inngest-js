/**
 * @module
 * The peek: with Doom picked but the sound muted, the face now and then
 * slides in from a screen edge, glances left and right, and ducks away.
 * Silent, rare (every one to three minutes), never while the reader is typing
 * or over a control, and off under reduced motion. `Shift+E` shows it now.
 */
import { faceUrl } from "./faces.ts";

const width = 72;
const height = 88;

let element: HTMLDivElement | null = null;
let image: HTMLImageElement | null = null;
let busy = false;
let timer: number | undefined;
let lastKey = -1e9;
let wanted: () => boolean = () => {
  return false;
};

const calm = () => {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

const typing = () => {
  const active = document.activeElement;

  return (
    Boolean(active?.closest?.("input, textarea, [contenteditable], .monaco-editor")) ||
    performance.now() - lastKey < 4000
  );
};

const make = () => {
  if (element && image) {
    return { element, image };
  }

  element = document.createElement("div");
  image = document.createElement("img");
  element.id = "sound-peek";
  element.setAttribute("aria-hidden", "true");
  image.alt = "";
  image.width = width;
  image.height = height;
  element.append(image);
  document.body.append(element);

  return { element, image };
};

/**
 * Shows the face now, if it fits somewhere clear. Returns whether it did.
 */
export const showPeek = () => {
  if (busy || !calm()) {
    return false;
  }

  const { element: box, image: face } = make();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const depth = height * 0.62;

  for (let tries = 0; tries < 12; tries++) {
    const edge = ["top", "right", "bottom", "left"][
      Math.floor(Math.random() * 4)
    ];
    const along = 0.1 + Math.random() * 0.8;
    let hidden: [number, number];
    let shown: [number, number];
    let turn: number;
    let area: [number, number, number, number];

    if (edge === "bottom") {
      const x = along * vw;

      hidden = [x, vh + height / 2];
      shown = [x, vh + height / 2 - depth];
      turn = 0;
      area = [x - width / 2, vh - depth, width, depth];
    } else if (edge === "top") {
      const x = along * vw;

      hidden = [x, -height / 2];
      shown = [x, -height / 2 + depth];
      turn = 180;
      area = [x - width / 2, 0, width, depth];
    } else if (edge === "left") {
      const y = along * vh;

      hidden = [-height / 2, y];
      shown = [-height / 2 + depth, y];
      turn = 90;
      area = [0, y - width / 2, depth, width];
    } else {
      const y = along * vh;

      hidden = [vw + height / 2, y];
      shown = [vw + height / 2 - depth, y];
      turn = -90;
      area = [vw - depth, y - width / 2, depth, width];
    }

    const clear = [
      [0.5, 0.5],
      [0.1, 0.1],
      [0.9, 0.1],
      [0.1, 0.9],
      [0.9, 0.9],
    ].every(([a, b]) => {
      const x = Math.min(vw - 1, Math.max(0, area[0] + (a ?? 0) * area[2]));
      const y = Math.min(vh - 1, Math.max(0, area[1] + (b ?? 0) * area[3]));

      return !document.elementsFromPoint(x, y).some((el) => {
        return el.matches("button, a, input, textarea, select, summary, [tabindex]");
      });
    });

    if (!clear) {
      continue;
    }

    const place = ([cx, cy]: [number, number]) => {
      return `translate(${cx - width / 2}px, ${cy - height / 2}px) rotate(${turn}deg)`;
    };

    busy = true;
    face.src = faceUrl("st00");
    box.style.visibility = "visible";

    const slideIn = box.animate(
      [{ transform: place(hidden) }, { transform: place(shown) }],
      { duration: 320, easing: "ease-out", fill: "forwards" },
    );

    window.setTimeout(() => {
      face.src = faceUrl("st01");
    }, 700);
    window.setTimeout(() => {
      face.src = faceUrl("st02");
    }, 1250);
    window.setTimeout(() => {
      face.src = faceUrl("st00");
    }, 1700);
    window.setTimeout(() => {
      const slideOut = box.animate(
        [{ transform: place(shown) }, { transform: place(hidden) }],
        { duration: 280, easing: "ease-in", fill: "forwards" },
      );

      slideOut.onfinish = () => {
        slideIn.cancel();
        slideOut.cancel();
        box.style.visibility = "hidden";
        busy = false;
      };
    }, 2000);

    return true;
  }

  return false;
};

const tick = () => {
  timer = undefined;

  if (!wanted()) {
    return;
  }

  if (typing()) {
    timer = window.setTimeout(tick, 10_000);

    return;
  }

  showPeek();
  plan();
};

/**
 * Plans the next peek one to three minutes away, if one is wanted.
 */
export const plan = () => {
  window.clearTimeout(timer);
  timer = undefined;

  if (!wanted() || !calm()) {
    return;
  }

  timer = window.setTimeout(tick, 60_000 + Math.random() * 120_000);
};

/**
 * Starts watching keys (so it never peeks while the reader types) and says
 * when a peek is wanted.
 */
export const startPeeking = (isWanted: () => boolean) => {
  wanted = isWanted;
  window.addEventListener(
    "keydown",
    () => {
      lastKey = performance.now();
    },
    true,
  );
};
