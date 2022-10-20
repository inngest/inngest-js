import { Container } from "./components/Container";
import { Content } from "./components/Content";
import { DevServerBar } from "./components/DevServerBar";
import { IntrospectProvider } from "./components/Introspect";

export function App() {
  return (
    <IntrospectProvider>
      <DevServerBar />
      <Container>
        <Content />
      </Container>
    </IntrospectProvider>
  );
}
