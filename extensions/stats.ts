import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { createServer, type Socket } from "net";

export default function (pi: ExtensionAPI) {
  const name = process.env.MINNX_PROC_NAME;
  if (!name) return;

  const baseDir = process.cwd();
  const statsFile = join(baseDir, "stats", name + ".json");
  const socketPath = join(baseDir, "sockets", name + ".sock");

  mkdirSync(dirname(statsFile), { recursive: true });
  mkdirSync(dirname(socketPath), { recursive: true });

  // --- Stats tracking ---

  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;

  pi.on("agent_end", async (event, ctx) => {
    for (const msg of event.messages) {
      if (msg.role === "assistant" && msg.usage?.cost) {
        totalCost += msg.usage.cost.total;
        totalInput += msg.usage.input;
        totalOutput += msg.usage.output;
      }
    }

    writeFileSync(statsFile, JSON.stringify({
      model: ctx.model?.id || null,
      cost: Math.round(totalCost * 10000) / 10000,
      tokens: { input: totalInput, output: totalOutput }
    }) + "\n");
  });

  // --- Socket server for two-way communication ---

  // Track which socket connections are waiting for a response
  const pendingClients: Set<Socket> = new Set();

  // Stream text deltas to all pending clients
  pi.on("message_update", async (event) => {
    if (pendingClients.size === 0) return;
    if (event.assistantMessageEvent?.type === "text_delta") {
      const data = JSON.stringify({
        type: "text_delta",
        delta: event.assistantMessageEvent.delta
      }) + "\n";
      for (const client of pendingClients) {
        try { client.write(data); } catch (e) {}
      }
    }
  });

  // Signal completion to all pending clients
  pi.on("agent_end", async () => {
    const data = JSON.stringify({ type: "done" }) + "\n";
    for (const client of pendingClients) {
      try { client.write(data); } catch (e) {}
      pendingClients.delete(client);
    }
  });

  // Clean up stale socket
  try { unlinkSync(socketPath); } catch (e) {}

  const server = createServer((conn) => {
    let buf = "";

    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "prompt" && msg.message) {
            pendingClients.add(conn);
            pi.sendUserMessage(msg.message, { deliverAs: "followUp" });
          }
        } catch (e) {
          conn.write(JSON.stringify({ type: "error", message: "invalid JSON" }) + "\n");
        }
      }
    });

    conn.on("close", () => {
      pendingClients.delete(conn);
    });

    conn.on("error", () => {
      pendingClients.delete(conn);
    });
  });

  server.listen(socketPath);

  // Cleanup on exit
  pi.on("session_end", async () => {
    server.close();
    try { unlinkSync(socketPath); } catch (e) {}
  });
}
