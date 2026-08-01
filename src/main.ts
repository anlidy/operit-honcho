import { honchoController } from "./runtime";

function isChatPrompt(payload: ToolPkg.PromptHookEventPayload): boolean {
  const value = String(payload.promptFunctionType || payload.functionType || "CHAT").toUpperCase();
  return value === "CHAT";
}

export function registerToolPkg(): boolean {
  ToolPkg.registerChatMessageHook({
    id: "honcho_message_persisted",
    function: onChatMessage,
  });
  ToolPkg.registerSystemPromptComposeHook({
    id: "honcho_mode_header",
    function: onSystemPromptCompose,
  });
  ToolPkg.registerPromptFinalizeHook({
    id: "honcho_memory_context",
    function: onPromptFinalize,
  });
  ToolPkg.registerAppLifecycleHook({
    id: "honcho_flush_on_terminate",
    event: "application_on_terminate",
    function: onApplicationTerminate,
  });
  return true;
}

export function onChatMessage(event: ToolPkg.ChatMessageHookEvent): null {
  if (event.eventName !== "message_persisted") return null;
  const payload = event.eventPayload;
  honchoController.queuePersistedMessage({
    chatId: payload.chatId,
    timestamp: payload.timestamp,
    sender: payload.sender,
    roleName: payload.roleName,
    content: payload.content,
    completedAt: payload.completedAt,
  });
  return null;
}

export function onSystemPromptCompose(
  event: ToolPkg.SystemPromptComposeHookEvent
): ToolPkg.PromptHookObjectResult | null {
  const payload = event.eventPayload;
  const stage = String(payload.stage || event.eventName || "");
  if (stage !== "after_compose_system_prompt" || !isChatPrompt(payload)) return null;

  const header = honchoController.systemPromptHeader();
  if (!header) return null;
  const current = String(payload.systemPrompt || "");
  if (current.includes("<honcho-memory-mode>")) return null;
  return { systemPrompt: current ? `${current}\n\n${header}` : header };
}

export async function onPromptFinalize(
  event: ToolPkg.PromptFinalizeHookEvent
): Promise<ToolPkg.PromptHookObjectResult | null> {
  const payload = event.eventPayload;
  const stage = String(payload.stage || event.eventName || "");
  if (stage !== "before_send_to_model" || !isChatPrompt(payload)) return null;

  const input = String(payload.processedInput || payload.rawInput || "");
  const chatId = String(payload.chatId || (typeof getChatId === "function" ? getChatId() : "") || "default");
  if (!input.trim()) return null;

  try {
    const injected = await honchoController.injectForPrompt(chatId, input);
    return injected ? { processedInput: injected } : null;
  } catch (error) {
    console.log(`[honcho] prompt injection failed: ${String(error)}`);
    return null;
  }
}

export async function onApplicationTerminate(): Promise<ToolPkg.JsonValue> {
  try {
    await honchoController.flushAll();
    return { ok: true };
  } catch (error) {
    console.log(`[honcho] shutdown flush failed: ${String(error)}`);
    return { ok: false, error: String(error) };
  }
}
