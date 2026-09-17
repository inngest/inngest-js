/**
 * A stand-in for a deploy provider's SDK.
 *
 * Its first call fails, so the demo has something that retries: the `deploy`
 * job wraps it in `step.run`, the step fails once, and the trace shows the
 * retry without the rest of the pipeline running again.
 */
export class FakeDeploys {
  private attempts = 0;

  async create(opts: {
    sha: string;
    environment: "preview" | "production";
  }): Promise<{ url: string; attempts: number }> {
    this.attempts += 1;

    if (this.attempts === 1) {
      const error = new Error("deploy provider returned 503") as Error & {
        statusCode: number;
      };
      error.statusCode = 503;
      throw error;
    }

    return {
      url: `https://${opts.environment}-${opts.sha.slice(0, 7)}.example.dev`,
      attempts: this.attempts,
    };
  }
}

export const deploys = new FakeDeploys();
