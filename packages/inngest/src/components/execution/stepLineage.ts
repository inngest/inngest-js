/**
 * Observes which steps a newly-discovered step was waiting on, so run
 * visualisations can draw joins instead of declining to.
 *
 * The engine already knows the *last* step whose resumption unblocked a
 * continuation: it resumes memoised steps one at a time and drains microtasks
 * between each. That is enough for chains and fan-outs, but not for a join —
 * `Promise.all([a, b])` looks identical to "waited on b alone" from there.
 *
 * The missing half is visible at the moment the join is built. A combinator
 * reaches each element through `PromiseResolve`, which returns a native promise
 * unchanged, and then invokes `.then` on it — so an own `then` property on the
 * promise we hand back sees every element of the call, synchronously, in one
 * block. `await` does not call `then` at all (it uses the internal
 * PerformPromiseThen), so in practice almost the only thing that registers is a
 * combinator. That makes "registered in the same synchronous block" a very
 * nearly pure combinator detector, and it catches `Promise.all`, `allSettled`,
 * `race`, `any`, nested combinators, and hand-rolled joins in libraries like
 * p-map or Bluebird, which all reach a promise the same way.
 *
 * Nothing global is patched, and the promise stays a plain native promise:
 * `instanceof Promise`, `constructor === Promise`, `Promise.resolve(p) === p`
 * and its prototype are all unchanged, so no subclass compatibility questions
 * arise. The only change is one own, non-enumerable property.
 *
 * Diagnostic only. Nothing about execution depends on any of it.
 */

/**
 * Identity for one `step.*` call, created before the step's hashed ID is known.
 *
 * The ID is only available after `applyMiddlewareToStep` has awaited, but a
 * combinator registers on the promise before that resolves. So groups are keyed
 * by token and resolved to hashed IDs later, when they are read.
 */
export interface StepPromiseToken {
  hashedId?: string;
}

export class StepLineage {
  /**
   * Tokens whose `then` was registered in a given synchronous block. A block
   * with two or more of them is a combinator call.
   */
  #groups = new Map<number, Set<StepPromiseToken>>();

  /** The group each token belongs to, once its group has more than one member. */
  #groupOf = new WeakMap<StepPromiseToken, Set<StepPromiseToken>>();

  #block = 0;
  #blockScheduled = false;

  /** Hashed IDs resumed so far in this request, in resumption order. */
  #resumed = new Set<string>();

  /**
   * Wraps the promise handed back to user code so combinator calls on it are
   * visible, and returns it. The promise itself is untouched and still native.
   */
  tag(promise: Promise<unknown>, token: StepPromiseToken): Promise<unknown> {
    const lineage = this;
    const then = Promise.prototype.then;

    Object.defineProperty(promise, "then", {
      value: function (
        this: Promise<unknown>,
        onFulfilled?: unknown,
        onRejected?: unknown,
      ) {
        lineage.#register(token, onFulfilled);
        return then.call(
          this,
          onFulfilled as never,
          onRejected as never,
        ) as Promise<unknown>;
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });

    return promise;
  }

  #register(token: StepPromiseToken, onFulfilled: unknown): void {
    // Every combinator passes an `onFulfilled`; `p.catch(f)` is
    // `then(undefined, f)`. Two unrelated `.catch()` calls in one block would
    // otherwise look like a join, and that is the only common false positive.
    if (typeof onFulfilled !== "function") {
      return;
    }

    if (!this.#blockScheduled) {
      this.#blockScheduled = true;
      queueMicrotask(() => {
        this.#block++;
        this.#blockScheduled = false;
      });
    }

    let group = this.#groups.get(this.#block);
    if (!group) {
      group = new Set();
      this.#groups.set(this.#block, group);
    }
    group.add(token);

    if (group.size > 1) {
      for (const member of group) {
        this.#groupOf.set(member, group);
      }
    }
  }

  /** Records that a memoised step has been resumed in this request. */
  markResumed(hashedId: string): void {
    this.#resumed.add(hashedId);
  }

  /**
   * The steps a newly-discovered step was waiting on, given the step whose
   * resumption unblocked it.
   *
   * If that step was part of a combinator call, the group is what the
   * continuation was waiting for — but only the members that have actually been
   * resumed. A member still unresumed means the continuation advanced before
   * everything had completed, i.e. `race`/`any` rather than `all`: exactly one
   * member unblocked it, and the rest are alternates that could have.
   */
  parentsOf(resuming: string, tokenOf: (id: string) => StepPromiseToken | undefined): {
    parents: string[];
    alternates: string[];
  } {
    const token = tokenOf(resuming);
    const group = token && this.#groupOf.get(token);

    if (!group) {
      return { parents: [resuming], alternates: [] };
    }

    const ids: string[] = [];
    for (const member of group) {
      if (member.hashedId) {
        ids.push(member.hashedId);
      }
    }

    const resumed = ids.filter((id) => this.#resumed.has(id));
    const pending = ids.filter((id) => !this.#resumed.has(id));

    if (pending.length) {
      return { parents: [resuming], alternates: pending };
    }

    return { parents: resumed.length ? resumed : [resuming], alternates: [] };
  }
}
