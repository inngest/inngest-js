"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const inngest_1 = require("inngest");
const express_2 = require("inngest/express");
const inngest = new inngest_1.Inngest({ id: "anthropic-claude-pdf-processing" });
const pdfFunction = inngest.createFunction({ id: "pdf-function" }, { event: "pdf-function/event" }, (_a) => __awaiter(void 0, [_a], void 0, function* ({ step }) {
    const result = yield step.ai.infer("parse-pdf", {
        model: (0, inngest_1.anthropic)({
            model: "claude-3-5-sonnet-latest",
            defaultParameters: { max_tokens: 3094 },
        }),
        body: {
            max_tokens: 3094,
            model: "claude-3-5-sonnet-latest",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "document",
                            source: {
                                type: "url",
                                url: "https://assets.anthropic.com/m/1cd9d098ac3e6467/original/Claude-3-Model-Card-October-Addendum.pdf",
                            },
                        },
                        {
                            type: "text",
                            text: "What are the key findings in this document?",
                        },
                    ],
                },
            ],
        },
    });
    return result.content[0].type === "text"
        ? result.content[0].text
        : result.content[0];
}));
const app = (0, express_1.default)();
// Important:  ensure you add JSON middleware to process incoming JSON POST payloads.
app.use(express_1.default.json());
app.use(
// Expose the middleware on our recommended path at `/api/inngest`.
"/api/inngest", (0, express_2.serve)({ client: inngest, functions: [pdfFunction] }));
app.listen(3000, () => {
    console.log("Server is running on port 3000");
});
