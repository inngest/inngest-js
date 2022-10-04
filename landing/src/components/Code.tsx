import { classNames } from "../utils/classnames";

interface Props {
  copiable?: boolean;
  value: string;
}

export const Code = ({ copiable, value }: Props) => {
  return (
    <code
      class={classNames({
        "flex flex-row space-x-2 items-center justify-center": true,
        "cursor-pointer": Boolean(copiable),
      })}
      onClick={
        copiable
          ? () => {
              navigator.clipboard.writeText(value);
            }
          : undefined
      }
    >
      <span>{value}</span>
      {copiable ? <CopySvg /> : null}
    </code>
  );
};

const CopySvg = () => {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M15 15H20C20.5523 15 21 14.5523 21 14V4C21 3.44772 20.5523 3 20 3L10 3C9.44772 3 9 3.44771 9 4L9 9"
        stroke="#1e293b"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M4 21L14 21C14.5523 21 15 20.5523 15 20L15 10C15 9.44772 14.5523 9 14 9L4 9C3.44771 9 3 9.44771 3 10L3 20C3 20.5523 3.44771 21 4 21Z"
        stroke="#1e293b"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
};
