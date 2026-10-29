/**
 * @module
 * Reads the runs of the current Run from the Dev Server's GraphQL API and
 * shapes them for the Trace panel.
 */
import type { TraceRun, TraceStep } from "../shared/types.ts";
import type { DevServer } from "./devserver.ts";

const spanFields = `
  spanID name status stepOp stepID attempts duration startedAt endedAt
  outputID isUserland stepType groupKind
`;

const runsQuery = `
  query Runs($from: Time!) {
    runs(
      first: 50
      orderBy: [{ field: QUEUED_AT, direction: ASC }]
      filter: { from: $from }
    ) {
      edges {
        node {
          id status queuedAt startedAt endedAt output
          function { name slug }
          trace {
            outputID
            ${spanFields}
            childrenSpans {
              ${spanFields}
              childrenSpans { ${spanFields} childrenSpans { ${spanFields} } }
            }
          }
        }
      }
    }
  }
`;

interface Span {
  spanID: string;
  name: string;
  status: string;
  stepOp: string | null;
  stepID: string | null;
  attempts: number | null;
  duration: number | null;
  startedAt: string | null;
  endedAt: string | null;
  outputID: string | null;
  isUserland: boolean;
  stepType: string | null;
  groupKind: string | null;
  childrenSpans?: Span[];
}

interface RunNode {
  id: string;
  status: string;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  output: string | null;
  function: { name: string; slug: string };
  trace: (Span & { outputID: string | null }) | null;
}

const stepOf = (span: Span): TraceStep => {
  return {
    id: span.stepID ?? span.spanID,
    name: span.name,
    op: span.stepOp,
    status: span.status,
    attempts: span.attempts,
    duration: span.duration,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    outputID: span.outputID,
    userland: span.isUserland,
    type: span.stepType,
    group: span.groupKind,
    children: (span.childrenSpans ?? []).map(stepOf),
  };
};

export const terminal = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "SKIPPED",
]);

export const readRuns = async (devServer: DevServer, from: string) => {
  const data = await devServer.gql<{
    runs: { edges: { node: RunNode }[] };
  }>(runsQuery, { from });

  return data.runs.edges
    .filter(({ node }) => {
      return !/-(cleanup|finished|arrival)$/.test(node.function.slug);
    })
    .map(({ node }): TraceRun => {
      return {
        id: node.id,
        fn: node.function.name,
        status: node.status,
        queuedAt: node.queuedAt,
        startedAt: node.startedAt,
        endedAt: node.endedAt,
        output: node.trace?.outputID ?? null,
        steps: (node.trace?.childrenSpans ?? []).map(stepOf),
      };
    });
};

export const readOutput = async (devServer: DevServer, outputID: string) => {
  const data = await devServer.gql<{
    runTraceSpanOutputByID: {
      input: string | null;
      data: string | null;
      error: { message: string; name: string | null } | null;
    };
  }>(
    `query Output($id: String!) {
       runTraceSpanOutputByID(outputID: $id) { input data error { message name } }
     }`,
    { id: outputID },
  );

  return data.runTraceSpanOutputByID;
};

export const cancelRun = async (devServer: DevServer, runID: string) => {
  await devServer.gql(
    `mutation Cancel($id: ULID!) { cancelRun(runID: $id) { id } }`,
    { id: runID },
  );
};
