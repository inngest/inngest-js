import { ComponentChildren, createContext } from "preact";
import { useIntrospect } from "../hooks/useFnIntrospect";
import { ExpectedIntrospection } from "../types";

export type IntrospectValue = {
  value: ExpectedIntrospection | undefined;
  retry: () => void;
  loading: boolean;
  error?: Error | undefined;
};

const Data = createContext<IntrospectValue>({ value: undefined, retry: () => {}, loading: false });

export const IntrospectConsumer = Data.Consumer;

export const IntrospectProvider = ({ children }: { children: ComponentChildren }) => {
  const { value, retry, loading, error } = useIntrospect();
  return (
    <Data.Provider value={{ value, retry, loading, error }}>
      {children}
    </Data.Provider>
  );
}
