import {
  ConnectMessage,
  GatewayExecutorRequestData,
  StartRequest,
  StartResponse,
} from "../../proto/src/components/connect/protobuf/connect.js";

export function createStartRequest() {
  return StartRequest.encode(StartRequest.create({})).finish();
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
