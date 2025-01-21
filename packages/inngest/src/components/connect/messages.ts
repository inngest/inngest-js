import {
  ConnectMessage,
  StartRequest,
  StartResponse,
} from "./protobuf/src/protobuf/connect";

export function createStartRequest() {
  return StartRequest.encode(StartRequest.create({})).finish();
}

export async function parseStartResponse(r: Response) {
  const startResp = StartResponse.decode(new Uint8Array(await r.arrayBuffer()));
  return startResp;
}

export async function parseConnectMessage(r: Uint8Array) {
  const connectMessage = ConnectMessage.decode(r);
  return connectMessage;
}
