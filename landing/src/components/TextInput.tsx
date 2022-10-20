import { ComponentChildren } from "preact";
import { classNames } from "../utils/classnames";

export interface TextInputProps {
  label?: string;
  value?: string;
  onChange?: (value: string) => void;
  className?: string;
}

export const TextInput = ({
  value,
  label,
  onChange,
  className = "",
}: TextInputProps) => {
  return (
    <>
      {label ? <Label>{label}</Label> : null}
      <input
        class={classNames({
          "w-full bg-gray-100 rounded p-2 focus:outline-none focus:ring focus:border-blue-500":
            true,
          [className]: true,
        })}
        type="text"
        value={value}
        onChange={(e) => onChange?.(e.currentTarget.value)}
      />
    </>
  );
};

export interface TextAreaInputProps {
  label?: string;
  value?: string;
  onChange?: (value: string) => void;
  className?: string;
  disabled?: boolean;
}

export const TextAreaInput = ({
  value,
  label,
  onChange,
  className = "",
  disabled
}: TextAreaInputProps) => {
  return (
    <>
      {label ? <Label>{label}</Label> : null}
      <textarea
        disabled={disabled}
        class={classNames({
          "w-full bg-gray-100 rounded p-2 focus:outline-none focus:ring focus:border-blue-500":
            true,
          [className]: true,
        })}
        value={value}
        onChange={(e) => onChange?.(e.currentTarget.value)}
      />
    </>
  );
};

interface LabelProps {
  children: ComponentChildren;
}

const Label = ({ children }: LabelProps) => {
  return <label class="font-semibold text-sm">{children}</label>;
};
