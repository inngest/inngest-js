import { Container } from "./components/Container";
import { Content } from "./components/Content";
import { DevServerBar } from "./components/DevServerBar";
import { IntrospectProvider } from "./components/Introspect";
import { ToastWrapper } from "./components/Toast";

export function App() {
  return (
    <ToastWrapper>
      <IntrospectProvider>
        <DevServerBar />
        <Container>
          <Content />
        </Container>
      </IntrospectProvider>
    </ToastWrapper>
  );
}
