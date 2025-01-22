import {
  ConnectMessage,
  GatewayExecutorRequestData,
  StartRequest,
  StartResponse,
} from "./protobuf/src/protobuf/connect.js";

export function createStartRequest() {
  return StartRequest.encode(StartRequest.create({})).finish();
}

export async function parseStartResponse(r: Response) {
  const startResp = StartResponse.decode(new Uint8Array(await r.arrayBuffer()));
  return startResp;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function parseConnectMessage(r: Uint8Array) {
  const connectMessage = ConnectMessage.decode(r);
  return connectMessage;
}

export async function parseGatewayExecutorRequest(r: Uint8Array) {
  const gatewayExecutorRequest = GatewayExecutorRequestData.decode(r);
  return gatewayExecutorRequest;
}
