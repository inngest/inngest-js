import { run } from "mitata";
import { register } from "./execution";

register().then(() => {
  return run();
});
