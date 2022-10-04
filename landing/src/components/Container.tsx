import { ComponentChildren } from "preact";

interface Props {
  children: ComponentChildren;
}

/**
 * A full-width container.
 */
export const Container = ({ children }: Props) => {
  return <div class="w-full h-full">{children}</div>;
};

/**
 * A consistent wrapper for page content.
 */
export const Wrapper = ({ children }: Props) => {
  return (
    <div class="w-full flex justify-center">
      <div class="w-[70rem] max-w-full px-8">{children}</div>
    </div>
  );
};
