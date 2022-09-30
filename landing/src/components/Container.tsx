import { ComponentChildren } from "preact";

interface Props {
  children: ComponentChildren;
}

export const Container = ({ children }: Props) => {
  return <div class="w-full">{children}</div>;
};

export const Wrapper = ({ children }: Props) => {
  return (
    <div class="w-full flex justify-center">
      <div class="w-[70rem] max-w-full px-8">{children}</div>
    </div>
  );
};
