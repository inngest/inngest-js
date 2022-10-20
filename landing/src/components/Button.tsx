import { ComponentChildren } from "preact";

export interface ButtonProps {
  children: ComponentChildren;
  type?: string;
  onClick?: any;
  disabled?: boolean;
}

export const Button = ({ children, onClick, type, disabled }: ButtonProps) => {
  const color = disabled ? "bg-slate-400" : "bg-blue-500";

  return (
    <button class={`${color} text-white px-5 py-1 font-semibold rounded`} onClick={onClick} type={type} disabled={disabled}>
      {children}
    </button>
  );
};
