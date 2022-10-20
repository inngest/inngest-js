import { ComponentChildren } from "preact";

export interface ButtonProps {
  children: ComponentChildren;
}

export const Button = ({ children }: ButtonProps) => {
  return (
    <button class="bg-blue-500 text-white px-5 py-1 font-semibold rounded">
      {children}
    </button>
  );
};
