/**
 * @module
 * EXPERIMENTAL: the small subset of CEL a thread key is written in. A thread
 * key is an expression over the trigger event, because the backend reads it
 * (as the function's singleton key and in the inbox filters) and the run
 * reads it too, so both must agree on what it means. The backend evaluates
 * the expression as written; the SDK evaluates it here, in the subset below,
 * and rejects anything else when the agent is defined.
 *
 * Supported: string and number literals, `true` and `false`, paths from
 * `event` (`event.data.channel`), `has(path)`, `+`
 * (string concatenation or addition), `==`, `!=`, `&&`, `||`, `!`,
 * `condition ? a : b` and parentheses. A path that is missing is an error, as
 * in CEL, so guard optional fields with `has()`.
 */

type Token =
  | { type: "string"; value: string; start: number; end: number }
  | { type: "number"; value: number; start: number; end: number }
  | { type: "ident"; value: string; start: number; end: number }
  | { type: "op"; value: string; start: number; end: number };

const operators = ["==", "!=", "&&", "||", "+", "!", "?", ":", "(", ")", "."];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i] as string;

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      let value = "";
      let j = i + 1;

      while (j < source.length && source[j] !== char) {
        if (source[j] === "\\") {
          j += 1;

          if (!["\\", '"', "'"].includes(source[j] ?? "")) {
            throw new Error(
              `Unsupported escape in "${source}": only \\\\, \\" and \\' are.`,
            );
          }
        }
        value += source[j] ?? "";
        j += 1;
      }

      if (source[j] !== char) {
        throw new Error(`Unterminated string in "${source}".`);
      }

      tokens.push({ type: "string", value, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }

    const number = /^\d+(\.\d+)?/.exec(source.slice(i));
    if (number) {
      tokens.push({
        type: "number",
        value: Number(number[0]),
        start: i,
        end: i + number[0].length,
      });
      i += number[0].length;
      continue;
    }

    const ident = /^[A-Za-z_]\w*/.exec(source.slice(i));
    if (ident) {
      tokens.push({
        type: "ident",
        value: ident[0],
        start: i,
        end: i + ident[0].length,
      });
      i += ident[0].length;
      continue;
    }

    const op = operators.find((candidate) => {
      return source.startsWith(candidate, i);
    });
    if (!op) {
      throw new Error(
        `Unsupported syntax "${char}" in "${source}". A thread key may use paths from event, strings, numbers, has(), +, ==, !=, &&, ||, !, ?: and parentheses.`,
      );
    }

    tokens.push({ type: "op", value: op, start: i, end: i + op.length });
    i += op.length;
  }

  return tokens;
}

type Value = string | number | boolean;
type Node = (event: unknown) => Value;

function lookup(event: unknown, path: string[], source: string) {
  let current: unknown = event;

  for (const part of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      !(part in (current as Record<string, unknown>))
    ) {
      throw new Error(
        `"${source}": ${["event", ...path].join(".")} is not set on the event.`,
      );
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * CEL's `&&` and `||` absorb an error on one side when the other side decides
 * the result (`err || true` is `true`).
 * @param lhs Left side.
 * @param rhs Right side.
 * @param event The event.
 * @param decisive The value that decides: `true` for `||`, `false` for `&&`.
 */
function absorb(lhs: Node, rhs: Node, event: unknown, decisive: boolean) {
  let leftError: unknown;
  let left: boolean | undefined;

  try {
    left = Boolean(lhs(event));
  } catch (err) {
    leftError = err;
  }

  if (left === decisive) {
    return decisive;
  }

  const right = Boolean(rhs(event));
  if (right === decisive) {
    return decisive;
  }

  if (leftError) {
    throw leftError;
  }

  return right;
}

function parse(source: string): Node {
  const tokens = tokenize(source);
  let position = 0;

  function peek() {
    return tokens[position];
  }

  function isOp(value: string) {
    const token = peek();

    return token?.type === "op" && token.value === value;
  }

  function expect(value: string) {
    if (!isOp(value)) {
      throw new Error(`Expected "${value}" in "${source}".`);
    }

    position += 1;
  }

  function path(): string[] {
    const first = tokens[position];
    if (first?.type !== "ident" || first.value !== "event") {
      throw new Error(`A path must start with "event" in "${source}".`);
    }

    position += 1;
    const parts: string[] = [];

    while (isOp(".")) {
      position += 1;
      const part = tokens[position];
      if (part?.type !== "ident") {
        throw new Error(`Expected a field name after "." in "${source}".`);
      }

      parts.push(part.value);
      position += 1;
    }

    return parts;
  }

  function primary(): Node {
    const token = peek();

    if (!token) {
      throw new Error(`Unexpected end of "${source}".`);
    }

    if (token.type === "string" || token.type === "number") {
      position += 1;

      return () => {
        return token.value;
      };
    }

    if (isOp("(")) {
      position += 1;
      const inner = ternary();
      expect(")");

      return inner;
    }

    if (token.type === "ident") {
      if (token.value === "true" || token.value === "false") {
        position += 1;

        return () => {
          return token.value === "true";
        };
      }

      if (token.value === "has") {
        position += 1;
        expect("(");
        const target = path();
        expect(")");

        return (event) => {
          try {
            lookup(event, target, source);

            return true;
          } catch {
            return false;
          }
        };
      }

      const target = path();

      return (event) => {
        return lookup(event, target, source) as Value;
      };
    }

    throw new Error(`Unexpected "${String(token.value)}" in "${source}".`);
  }

  function unary(): Node {
    if (isOp("!")) {
      position += 1;
      const inner = unary();

      return (event) => {
        return !inner(event);
      };
    }

    return primary();
  }

  function add(): Node {
    let left = unary();

    while (isOp("+")) {
      position += 1;
      const lhs = left;
      const rhs = unary();
      left = (event) => {
        const a = lhs(event);
        const b = rhs(event);

        if (typeof a === "string" && typeof b === "string") {
          return a + b;
        }

        if (typeof a === "number" && typeof b === "number") {
          return a + b;
        }

        throw new Error(`"${source}": + needs two strings or two numbers.`);
      };
    }

    return left;
  }

  function equality(): Node {
    let left = add();

    while (isOp("==") || isOp("!=")) {
      const negate = (peek() as Token).value === "!=";
      position += 1;
      const lhs = left;
      const rhs = add();
      left = (event) => {
        return (lhs(event) === rhs(event)) !== negate;
      };
    }

    return left;
  }

  function and(): Node {
    let left = equality();

    while (isOp("&&")) {
      position += 1;
      const lhs = left;
      const rhs = equality();
      left = (event) => {
        return absorb(lhs, rhs, event, false);
      };
    }

    return left;
  }

  function or(): Node {
    let left = and();

    while (isOp("||")) {
      position += 1;
      const lhs = left;
      const rhs = and();
      left = (event) => {
        return absorb(lhs, rhs, event, true);
      };
    }

    return left;
  }

  function ternary(): Node {
    const condition = or();

    if (!isOp("?")) {
      return condition;
    }

    position += 1;
    const yes = ternary();
    expect(":");
    const no = ternary();

    return (event) => {
      return condition(event) ? yes(event) : no(event);
    };
  }

  const root = ternary();
  if (position < tokens.length) {
    throw new Error(`Unexpected trailing input in "${source}".`);
  }

  return root;
}

export interface Expression {
  /**
   * The expression when it is only a path of the event (`event.data.key`),
   * which a cancel expression can use.
   */
  path?: string;

  /**
   * The expression as written, over `event`.
   */
  source: string;

  /**
   * The expression over `async`, for the filter of a subscription.
   */
  asAsync: string;

  /**
   * Evaluates the expression for an event.
   */
  evaluate(event: unknown): Value;
}

/**
 * Rewrites the `event` paths of an expression to `async`, leaving string
 * literals and fields that happen to be called `event` alone.
 * @param source Expression over `event`.
 */
export function toAsync(source: string): string {
  return source
    .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)
    .map((piece, index) => {
      return index % 2 === 1
        ? piece
        : piece.replace(/(?<![\w.])event(?=\s*\.)/g, "async");
    })
    .join("");
}

/**
 * Parses an expression of the supported subset.
 * @param source The expression, over `event`.
 */
export function compileExpression(source: string): Expression {
  const root = parse(source);

  return {
    source,
    path: /^event(\.[A-Za-z_]\w*)+$/.test(source.trim())
      ? source.trim()
      : undefined,
    asAsync: toAsync(source),
    evaluate(event) {
      return root(event);
    },
  };
}

/**
 * Parses a thread key expression, which must evaluate to a non-empty string.
 * @param source The expression, over `event`.
 */
export function compileKey(source: string): Expression & {
  key(event: unknown): string;
} {
  const expression = compileExpression(source);

  return {
    ...expression,
    key(event) {
      const value = expression.evaluate(event);

      if (typeof value !== "string" || value === "") {
        throw new Error(
          `"${source}" must give a non-empty string, got ${JSON.stringify(value)}.`,
        );
      }

      return value;
    },
  };
}
