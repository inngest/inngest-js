import { useState } from "preact/hooks";
import "./app.css";

export function App() {
  const [count, setCount] = useState(0);

  return (
    <>
      <h1 class="text-3xl">Inngest</h1>
      <div>
        <button onClick={() => setCount((count) => count + 1)}>
          count is {count}
        </button>
        <p>
          Edit <code>src/app.tsx</code> and save to test HMR
        </p>
      </div>
      <p class="opacity-50 italic">
        Click on the Vite and Preact logos to learn more
      </p>
    </>
  );
}
