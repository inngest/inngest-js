import { ComponentChildren } from "preact";

export interface ButtonProps {
  children: ComponentChildren;
  type?: string;
  onClick?: any;
}

export const Button = ({ children, onClick, type }: ButtonProps) => {
  return (
    <button class="bg-blue-500 text-white px-5 py-1 font-semibold rounded" onClick={onClick} type={type}>
      {children}
    </button>
  );
};
