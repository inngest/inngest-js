/**
 * @module
 * Dividers between the four panes. Each is a focusable separator: drag it,
 * or press the arrow keys (Shift for bigger steps) while it has focus.
 */

export const clamp = (value: number, low: number, high: number) => {
  return Math.max(low, Math.min(high, value));
};

export const Divider = ({
  axis,
  value,
  label,
  low = 18,
  high = 82,
  onChange,
}: {
  axis: "vertical" | "horizontal";
  value: number;
  label: string;
  low?: number;
  high?: number;
  onChange: (next: number) => void;
}) => {
  const drag = (event: React.PointerEvent<HTMLDivElement>) => {
    const parent = event.currentTarget.parentElement as HTMLElement;
    const move = (next: PointerEvent) => {
      const box = parent.getBoundingClientRect();
      const share =
        axis === "vertical"
          ? ((next.clientX - box.left) / box.width) * 100
          : ((next.clientY - box.top) / box.height) * 100;

      onChange(clamp(share, low, high));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const less = axis === "vertical" ? "ArrowLeft" : "ArrowUp";
  const more = axis === "vertical" ? "ArrowRight" : "ArrowDown";

  return (
    <div
      className={`divider ${axis}`}
      role="separator"
      aria-orientation={axis}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={low}
      aria-valuemax={high}
      tabIndex={0}
      onPointerDown={drag}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 10 : 3;

        if (event.key === less) {
          event.preventDefault();
          onChange(clamp(value - step, low, high));
        } else if (event.key === more) {
          event.preventDefault();
          onChange(clamp(value + step, low, high));
        }
      }}
    />
  );
};
