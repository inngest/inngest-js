/**
 * @module
 * Small helpers for things that appear and disappear. The motion itself is
 * CSS (`.reveal` and `.fit` in styles.css, 200 ms ease-out, off under
 * `prefers-reduced-motion`); these components only measure heights and keep
 * a node mounted while it leaves, so a list below moves smoothly instead of
 * jumping.
 */
import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** Matches `--motion` in styles.css, plus a frame of slack. */
const settle = 230;

/**
 * Fades and grows its children in, and shrinks and fades them out, while the
 * height of whatever follows moves with it. At rest the height is `auto`, so
 * content that grows later (a nested list) is never clipped. `appear` false
 * skips the enter animation for what is already there on first render.
 */
export const Reveal = ({
  show = true,
  appear = true,
  className,
  children,
  ...rest
}: {
  show?: boolean;
  appear?: boolean;
  className?: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"div">, "className" | "children">) => {
  const [mounted, setMounted] = useState(show);
  const outer = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  const first = useRef(true);

  useLayoutEffect(() => {
    const isFirst = first.current;

    first.current = false;

    if (show && !mounted) {
      setMounted(true);

      return;
    }

    const el = outer.current;

    if (!el) {
      return;
    }

    let timer: number | undefined;

    if (show) {
      const fresh = !shown.current;

      shown.current = true;

      if (fresh && isFirst && !appear) {
        return;
      }

      if (fresh) {
        el.style.height = "0px";
        el.classList.add("reveal-closed");
      }

      void el.offsetHeight;
      el.classList.remove("reveal-closed");
      el.style.height = `${el.firstElementChild?.getBoundingClientRect().height ?? 0}px`;
      timer = window.setTimeout(() => {
        el.style.height = "";
      }, settle);
    } else if (shown.current) {
      shown.current = false;
      el.style.height = `${el.getBoundingClientRect().height}px`;
      void el.offsetHeight;
      el.classList.add("reveal-closed");
      el.style.height = "0px";
      timer = window.setTimeout(() => {
        setMounted(false);
      }, settle);
    }

    return () => {
      window.clearTimeout(timer);
    };
  }, [show, mounted, appear]);

  if (!mounted) {
    return null;
  }

  return (
    <div className={`reveal ${className ?? ""}`} ref={outer} {...rest}>
      <div className="reveal-inner">{children}</div>
    </div>
  );
};

/**
 * Keeps its own height in step with its content, so content that changes
 * size after it first shows (a "Loading..." line replaced by JSON) grows
 * instead of jumping.
 */
export const Fit = ({ children }: { children: ReactNode }) => {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = outer.current;
    const content = inner.current;

    if (!el || !content) {
      return;
    }

    const apply = () => {
      el.style.height = `${content.getBoundingClientRect().height}px`;
    };

    apply();

    const observer = new ResizeObserver(apply);

    observer.observe(content);

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div className="fit" ref={outer}>
      <div ref={inner}>{children}</div>
    </div>
  );
};
