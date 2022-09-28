import { ComponentChildren } from "preact";

interface Props {
  children: ComponentChildren;
}

export const Container = ({ children }: Props) => {
  return <div class="w-full">{children}</div>;
};
