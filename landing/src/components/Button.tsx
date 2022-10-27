import { ComponentChildren } from "preact";

export interface ButtonProps {
  children: ComponentChildren;
  type?: string;
  onClick?: any;
  disabled?: boolean;
  className?: string;
}

export const Button = ({
  children,
  onClick,
  type,
  disabled,
  className = "",
}: ButtonProps) => {
  const color = disabled ? "bg-slate-400" : "bg-blue-500";

  return (
    <button
      className={`${color} text-white px-5 py-1 font-semibold rounded ${className}`}
      onClick={onClick}
      type={type}
      disabled={disabled}
    >
      {children}
    </button>
  );
};
