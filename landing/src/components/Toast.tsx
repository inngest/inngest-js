import { ComponentChildren, createContext } from "preact";
import { useEffect, useState, useReducer, useContext } from "preact/hooks";

export enum ToastTypes {
  success,
  error,
  default,
}

export type ToastTypeStrings = keyof typeof ToastTypes;

export type Toast = {
  id?: string; // ID to dedupe
  type: ToastTypeStrings;
  message?: string;
  sticky?: boolean;
  icon?: any;
  /** Duration in milliseconds */
  duration?: number;
};

export type Context = {
  push: (t: Toast) => () => void;
  remove: (id: string) => void;
};

const ToastContext = createContext<Context>({
  push: (_t: Toast) => () => {},
  remove: (_id: String) => {},
});

type InternalToast = Toast & { id: string };

type Action =
  | { type: "add"; toast: InternalToast }
  | { type: "remove"; id: string };

type State = InternalToast[];

const reducer = (s: State, a: Action) => {
  switch (a.type) {
    case "add":
      // don't duplicate if ID exists
      if (s.find((s) => s.id === a.toast.id)) {
        return s;
      }
      return s.concat([{ ...a.toast }]);
    case "remove":
      return s.filter((t) => t.id !== a.id);
  }
};

// ToastWrapper is a top level component that renders all toasts to
// the UI and manages their lifecycles.
export const ToastWrapper = ({ children }: { children: ComponentChildren }) => {
  const [state, dispatch] = useReducer(reducer, []);

  const remove = (id: string) => dispatch({ type: "remove", id });
  const push = (t: Toast) => {
    const id = Math.random().toString(16);
    dispatch({ type: "add", toast: { ...t, id: t.id || id } });
    return () => remove(id);
  };

  return (
    <ToastContext.Provider value={{ push, remove }}>
      <div className="pointer-events-none fixed flex flex-col items-center justify-center w-full py-8">
        {state.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </div>
      {children}
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  return useContext(ToastContext);
};

export default useToast;

const defaultDuration = 5000;

const ToastItem = ({ toast }: { toast: InternalToast }) => {
  const { remove } = useToast();
  const [shown, setShown] = useState(false);

  const I = toast.icon;

  useEffect(() => {
    // Fade in nicely.
    setTimeout(() => {
      setShown(true);
    }, 25);

    // And hide this toast after N seconds
    setTimeout(() => {
      !toast.sticky && setShown(false);
    }, toast.duration || defaultDuration - 500);
    setTimeout(() => {
      !toast.sticky && remove(toast.id);
    }, toast.duration || defaultDuration);
  }, [toast.id]);

  const msg =
    toast.message || (toast.type === "error" ? "Something went wrong" : "");

  let color = "text-slate-200 bg-gray-800"
  switch (toast.type) {
  case "success":
    color = "text-slate-200 bg-green-600"
    break;
  case "error":
    color = "text-slate-200 bg-red-800"

  }

  if (!shown) { return null; }

  return (
    <div
      className={`flex items-center align-center justify-center p-4 w-full max-w-sm rounded-lg shadow-2xl ${color} text-center mb-2`}
      onClick={() => remove(toast.id)}
    >
      {I && <I size={22} style={{ marginRight: 10 }} />}
      <span>{msg.replace("[GraphQL] ", "").replace("[Network] ", "")}</span>
    </div>
  );
};
