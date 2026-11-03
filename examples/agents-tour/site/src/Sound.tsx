/**
 * @module
 * The sound controls: the speaker at the top right with its style menu, and
 * Doom's status bar and game over screen. All the state lives in `sound/`;
 * these draw it.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Kbd } from "./keyboard.tsx";
import { faceKey, faceUrl, type Look } from "./sound/faces.ts";
import {
  getState,
  pickStyle,
  setMenu,
  subscribe,
  toggleMuted,
} from "./sound/index.ts";
import { styles } from "./sound/styles.ts";

export const useSound = () => {
  return useSyncExternalStore(subscribe, getState);
};

/**
 * The speaker, beside the stack icon at the top right. Mouse only, out of the
 * Tab order and with no shortcut. Click it to turn sound on or off; hover it
 * for the style menu, numbered 1 to 5, and click a style to pick it.
 */
export const SoundButton = () => {
  const sound = useSound();
  const closeTimer = useRef<number | undefined>(undefined);
  const open = sound.menu;

  const openMenu = () => {
    window.clearTimeout(closeTimer.current);
    setMenu(true);
  };

  const leave = () => {
    closeTimer.current = window.setTimeout(() => {
      setMenu(false);
    }, 250);
  };

  // A click outside the menu closes it.
  useEffect(() => {
    if (!open) {
      return;
    }

    const onDown = (event: MouseEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".sound")
      ) {
        setMenu(false);
      }
    };

    window.addEventListener("mousedown", onDown);

    return () => {
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <span className="sound" onMouseEnter={openMenu} onMouseLeave={leave}>
      <button
        type="button"
        className={`ghost stack-button speaker${sound.muted ? "" : " on"}`}
        tabIndex={-1}
        aria-label="Sound"
        aria-pressed={!sound.muted}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggleMuted}
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 9h3.5L12 4.5v15L6.5 15H3z" />
          {sound.muted ? (
            <path d="m16 9 5 6m0-6-5 6" />
          ) : (
            <path d="M16 9a4 4 0 0 1 0 6m2.5-9a8 8 0 0 1 0 12" />
          )}
        </svg>
      </button>
      {open ? (
        <div id="sound-menu" className="sound-menu" role="menu">
          {styles.map((style, at) => {
            return (
              <button
                type="button"
                key={style.id}
                tabIndex={-1}
                role="menuitemradio"
                aria-checked={style.id === sound.style}
                className="sound-opt"
                onClick={() => {
                  pickStyle(style.id);
                  setMenu(false);
                }}
              >
                <kbd>{at + 1}</kbd>
                {style.name}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
};

/**
 * Doom's status bar: a dock at the bottom of the page, with the face, health,
 * weapons, ammo and score, the credit for Freedoom and the track playing.
 */
export const DoomBar = () => {
  const sound = useSound();
  const [look, setLook] = useState<Look>(0);
  const { game } = sound;

  useEffect(() => {
    if (!sound.doom) {
      return;
    }

    const timer = window.setInterval(() => {
      setLook(([-1, 0, 1, 0] as const)[Math.floor(Math.random() * 4)] ?? 0);
    }, 1700);

    return () => {
      window.clearInterval(timer);
    };
  }, [sound.doom]);

  const low = game.health <= 30;

  return (
    <div
      id="doom-bar"
      className={sound.doom ? "on" : ""}
      aria-hidden={!sound.doom}
      aria-label="Doom status bar"
    >
      <img
        id="doom-face"
        alt=""
        width={72}
        src={faceUrl(faceKey(game, look))}
      />
      <div className="doom-credit">
        <span>
          {sound.track.name}
          {sound.rendering ? " (preparing)" : ""}{" "}
          <Kbd action="soundTrack" short />
        </span>
        <a href="/freedoom/LICENSE" target="_blank" rel="noopener">
          Music and art: Freedoom (BSD licence)
        </a>
      </div>
      <div className="cell">
        <span className="lab">HEALTH</span>
        <span className={`num${low ? " low blink" : ""}`}>{game.health}</span>
      </div>
      <div className="cell">
        <span className="lab">ARMS</span>
        <div className="arms">
          {[1, 2, 3, 4].map((at) => {
            return (
              <i key={at} className={at === game.weapon ? "cur" : ""}>
                {at}
              </i>
            );
          })}
        </div>
      </div>
      <div className="cell">
        <span className="lab">AMMO</span>
        <span className="num sm">{game.ammo}</span>
      </div>
      <div className="cell">
        <span className="lab">SCORE</span>
        <span className="num sm">{game.score}</span>
      </div>
    </div>
  );
};

/**
 * The red screen at game over. It never takes input.
 */
export const GameOver = () => {
  const { game } = useSound();

  return (
    <div id="game-over" className={game.over ? "on" : ""} aria-hidden="true">
      <b>GAME OVER</b>
      {game.penalty > 0 ? <span>-{game.penalty}</span> : null}
    </div>
  );
};
