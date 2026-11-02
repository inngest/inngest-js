/**
 * @module
 * The sound controls: the speaker at the top right with its style menu, and
 * Doom's status bar and game over screen. All the state lives in `sound/`;
 * these draw it.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Kbd, shortcutsOf } from "./keyboard.tsx";
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
 * The speaker. Click to turn sound on or off; hover (or `Shift+M`) for the
 * style menu, numbered 1 to 5.
 */
export const SoundButton = () => {
  const sound = useSound();
  const [cursor, setCursor] = useState(0);
  const closeTimer = useRef<number | undefined>(undefined);
  const button = useRef<HTMLButtonElement>(null);
  const open = sound.menu;

  const openMenu = () => {
    window.clearTimeout(closeTimer.current);
    setCursor(
      Math.max(
        0,
        styles.findIndex((style) => {
          return style.id === sound.style;
        }),
      ),
    );
    setMenu(true);
  };

  const closeMenu = (refocus: boolean) => {
    setMenu(false);

    if (refocus) {
      button.current?.focus();
    }
  };

  const pick = (at: number) => {
    const style = styles[at];

    if (style) {
      pickStyle(style.id);
      closeMenu(true);
    }
  };

  // The menu's own keys. While it is open the page's keys are blocked.
  useEffect(() => {
    if (!open) {
      return;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      const eat = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      if (event.key === "Escape") {
        eat();
        closeMenu(true);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        eat();
        setCursor((at) => {
          return (
            (at + (event.key === "ArrowDown" ? 1 : -1) + styles.length) %
            styles.length
          );
        });
      } else if (event.key === "Enter") {
        eat();
        pick(cursor);
      } else if (/^[1-5]$/.test(event.key)) {
        eat();
        pick(Number(event.key) - 1);
      } else if (event.key === "m") {
        eat();
        toggleMuted();
      }
    };

    window.addEventListener("keydown", onKey, true);

    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, cursor]);

  const leave = () => {
    closeTimer.current = window.setTimeout(() => {
      if (
        !document.getElementById("sound-menu")?.contains(document.activeElement)
      ) {
        closeMenu(false);
      }
    }, 250);
  };

  return (
    <span className="sound" onMouseEnter={openMenu} onMouseLeave={leave}>
      <button
        type="button"
        ref={button}
        className={`ghost speaker${sound.muted ? "" : " on"}`}
        aria-label="Sound"
        aria-pressed={!sound.muted}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-keyshortcuts={shortcutsOf("soundToggle")}
        onClick={toggleMuted}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 6h2.5L8 3v10L4.5 10H2z" />
          {sound.muted ? (
            <path d="M11 6l3 4M14 6l-3 4" />
          ) : (
            <path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.3 3.8a6 6 0 0 1 0 8.4" />
          )}
        </svg>
        <Kbd action="soundToggle" short />
      </button>
      {open ? (
        <div id="sound-menu" className="sound-menu" role="menu">
          {styles.map((style, at) => {
            return (
              <button
                type="button"
                key={style.id}
                role="menuitemradio"
                aria-checked={style.id === sound.style}
                className={`sound-opt${at === cursor ? " cur" : ""}`}
                onClick={() => {
                  pick(at);
                }}
              >
                <kbd>{at + 1}</kbd>
                {style.name}
              </button>
            );
          })}
          <div className="sound-foot">arrows, Enter, Esc</div>
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
