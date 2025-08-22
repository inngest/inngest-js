import { Buffer } from "node:buffer";
import http from "node:http";
import { Socket } from "node:net";
import * as NodeHandler from "./node.ts";
import { testFramework } from "./test/helpers.ts";

testFramework("Node", NodeHandler, {
  transformReq: (req, res) => {
    const socket = new Socket();
    const nodeReq = new http.IncomingMessage(socket);

    // Set the method and URL
    nodeReq.method = req.method;
    nodeReq.url = req.url;

    if (req.protocol === "https") {
      nodeReq.headers["x-forwarded-proto"] = req.protocol;
    }

    // Set headers
    for (const [key, value] of Object.entries(req.headers)) {
      nodeReq.headers[key.toLowerCase()] = value;
    }

    // Mock the body data
    const bodyData = Buffer.from(JSON.stringify(req.body));

    // Override the read methods to return the body data
    nodeReq.push(bodyData);
    nodeReq.push(null); // Signals the end of the stream

    return [nodeReq, res];
  },
});
