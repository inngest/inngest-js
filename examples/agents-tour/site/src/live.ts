/**
 * @module
 * Two small buses on the window. `fakes` and `area` events (see `stream.ts`)
 * make a panel reload or react. `tour:action` events carry
 * a key action to the panel that owns it, so a key works the same from
 * Monaco, from a text box and from the page.
 */
import { useEffect, useRef, useState } from "react";
import type { ActionId } from "../../shared/keys.ts";
import type { AreaEventDetail } from "./stream.ts";

export type FakeTopic = "slack" | "github";

export const sendAction = (id: ActionId) => {
  window.dispatchEvent(new CustomEvent("tour:action", { detail: id }));
};

/**
 * Runs `run` whenever the key action `id` fires.
 */
export const useAction = (id: ActionId, run: () => void) => {
  const latest = useRef(run);

  latest.current = run;

  useEffect(() => {
    const onAction = (event: Event) => {
      if ((event as CustomEvent<ActionId>).detail === id) {
        latest.current();
      }
    };

    window.addEventListener("tour:action", onAction);

    return () => {
      window.removeEventListener("tour:action", onAction);
    };
  }, [id]);
};

/**
 * A state route of a fake, loaded now and again each time that fake says it
 * changed. A newer request wins over an older one.
 */
export const useFake = <T>(path: string, topic: FakeTopic) => {
  const [data, setData] = useState<T>();

  useEffect(() => {
    let alive = true;
    let latest = 0;
    const load = async () => {
      latest += 1;

      const mine = latest;

      try {
        const next = (await (await fetch(path)).json()) as T;

        if (alive && mine === latest) {
          setData(next);
        }
      } catch {
        // The server is restarting; the next change reloads.
      }
    };
    const onChange = (event: Event) => {
      if ((event as CustomEvent<FakeTopic>).detail === topic) {
        void load();
      }
    };

    void load();
    window.addEventListener("tour:fakes", onChange);

    return () => {
      alive = false;
      window.removeEventListener("tour:fakes", onChange);
    };
  }, [path, topic]);

  return data;
};

/**
 * Runs `run` with the data of each event an area sends on `topic`.
 */
export const useAreaEvent = (
  area: string,
  topic: string,
  run: (data: unknown) => void,
) => {
  const latest = useRef(run);

  latest.current = run;

  useEffect(() => {
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<AreaEventDetail>).detail;

      if (detail.area === area && detail.topic === topic) {
        latest.current(detail.data);
      }
    };

    window.addEventListener("tour:area", onEvent);

    return () => {
      window.removeEventListener("tour:area", onEvent);
    };
  }, [area, topic]);
};

export const postJson = async (path: string, body: unknown = {}) => {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return (await res.json().catch(() => {
    return {};
  })) as Record<string, unknown>;
};
