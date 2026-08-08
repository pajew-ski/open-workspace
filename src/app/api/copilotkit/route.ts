import { CopilotRuntime, OpenAIAdapter, copilotRuntimeNextJSAppRouterEndpoint } from "@copilotkit/runtime";
import OpenAI from "openai";
import { NextRequest } from "next/server";

/**
 * CopilotKit Runtime Endpoint
 * 
 * Bridges CopilotKit to our Ollama backend by using OpenAI-compatible endpoint.
 * Ollama serves an OpenAI-compatible API at localhost:11434/v1
 */

// Uses the same configuration source as the rest of the app; Ollama
// exposes an OpenAI-compatible API under /v1.
const LLM_BASE =
    process.env.LLM_API_BASE_URL ||
    process.env.NEXT_PUBLIC_LLM_API_BASE_URL ||
    "http://localhost:11434";
const OLLAMA_BASE_URL = LLM_BASE.includes("/v1") ? LLM_BASE : `${LLM_BASE.replace(/\/+$/, "")}/v1`;
const OLLAMA_MODEL =
    process.env.LLM_MODEL ||
    process.env.NEXT_PUBLIC_LLM_MODEL ||
    "gpt-oss:20b";

// Create OpenAI client configured for Ollama
const openai = new OpenAI({
    baseURL: OLLAMA_BASE_URL,
    apiKey: "ollama", // Ollama doesn't require a real key
});

// Use OpenAI adapter with the configured client
// Type assertion needed due to OpenAI SDK version differences
const serviceAdapter = new OpenAIAdapter({
    openai: openai as any,
    model: OLLAMA_MODEL,
});

const runtime = new CopilotRuntime();

export async function POST(req: NextRequest) {
    const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
        runtime,
        serviceAdapter,
        endpoint: "/api/copilotkit",
    });

    return handleRequest(req);
}
