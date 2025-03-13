import {
  ConnectMessage,
  GatewayExecutorRequestData,
  StartRequest,
  StartResponse,
  WorkerReplyAckData,
} from "../../proto/src/components/connect/protobuf/connect.ts";

export function createStartRequest(excludeGateways: string[]) {
  return StartRequest.encode(
    StartRequest.create({
      excludeGateways,
    }),
  ).finish();
}

export async function parseStartResponse(r: Response) {
  const startResp = StartResponse.decode(new Uint8Array(await r.arrayBuffer()));
  return startResp;
}

export function parseConnectMessage(r: Uint8Array) {
  const connectMessage = ConnectMessage.decode(r);
  return connectMessage;
}

export function parseGatewayExecutorRequest(r: Uint8Array) {
  const gatewayExecutorRequest = GatewayExecutorRequestData.decode(r);
  return gatewayExecutorRequest;
}

export function parseWorkerReplyAck(r: Uint8Array) {
  const workerReplyAck = WorkerReplyAckData.decode(r);
  return workerReplyAck;
}
