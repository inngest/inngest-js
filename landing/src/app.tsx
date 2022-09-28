import { Container } from "./components/Container";
import { Content } from "./components/Content";
import { DevServerBar } from "./components/DevServerBar";

export function App() {
  return (
    <>
      <DevServerBar />
      <Container>
        <Content />
      </Container>
    </>
  );
}
