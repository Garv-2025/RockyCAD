export const maxDuration = 60;
type ChatHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type OpenRouterMessage =
  | ChatHistoryMessage
  | { role: 'system'; content: string }
  | {
      role: 'user';
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
    };

const CAD_REFERENCE_CONTEXT = [
  'OpenSCAD parametric CSG: Always put $fn=100; at the top. Define all variables at the top of the script before geometry.',
  'To make a hollow tube, use difference() { cylinder(d=outer); translate([0,0,-1]) cylinder(d=inner, h=h+2); }. Give the outer cylinder the desired height h, and extend the inner cutter past both ends.',
  'Use union() to combine solids and difference() to subtract holes. Place dimensions in named variables for easy parametric editing.',
  'For a through-hole, make the cutter longer than the body and offset it so it extends beyond both faces. Use centered geometry or explicit translations consistently.',
].join('\n\n');

const SYSTEM_PROMPT = `You are a CAD assistant. Instead of raw OpenSCAD code, output a JSON array of primitive shapes matching the frontend scene state. Valid types are "box", "cylinder", "sphere", and "cone". Each object must include "type", "position" [x, y, z], "scale" [x, y, z], "rotation" [x, y, z], and "params".
For "box", the "params" object MUST contain exactly "width", "length", and "height" as numbers. Never use "thickness", "depth", or "size". Example: {"width": 50, "length": 50, "height": 5}.
For "cylinder", the "params" object MUST contain "radius" (number) and "height" (number). Do not use "diameter". To model regular polygonal prisms (such as a hexagonal hole or nut), use type "cylinder" and include a "segments" key in the "params" object (e.g., {"radius": 10, "height": 20, "segments": 6}). For smooth circles, omit "segments". For "cone", use radius and height keys. For "sphere", use "radius" (number).
CRITICAL: NEVER use the \`scale\` array to set physical dimensions. The \`scale\` array MUST ALWAYS be exactly \`[1, 1, 1]\`. You must define all sizes strictly inside the \`params\` object (e.g., \`radius\`, \`height\`, \`width\`).
Always place objects so they rest ON the floor. Because origins are center-based, the "position" Z-coordinate MUST always be exactly half of the object's height (e.g., if height is 40, position Z is 20).
To subtract geometry (make a hole), add "isHole": true. Put the complete JSON array strictly inside a \`\`\`json ... \`\`\` block. You may add a short, natural language explanation outside the block; do not output OpenSCAD code.

You are also an expert mechanical engineer. Use the retrieved OpenSCAD references below when relevant:
<retrieved_context>
${CAD_REFERENCE_CONTEXT}
</retrieved_context>

Understand the requested dimensions and CSG operations carefully. If a crucial dimension or requirement is missing, ask a concise clarifying question and do not invent shapes. Return an empty JSON array only when the user is asking a question rather than requesting geometry.
Keep coordinate calculations strictly under 3 sentences before outputting the final JSON array. Ensure every subtracting object explicitly includes "isHole": true.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChatHistoryMessage(value: unknown): value is ChatHistoryMessage {
  return isRecord(value) &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown OpenRouter error.';
}

async function requestCompletion(
  apiKey: string,
  model: string,
  messages: OpenRouterMessage[],
  signal: AbortSignal,
): Promise<Response> {
  const backendResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });

  if (!backendResponse.ok) {
    const result: unknown = await backendResponse.json().catch(() => null);
    const detail = isRecord(result) && isRecord(result.error) && typeof result.error.message === 'string'
      ? result.error.message
      : backendResponse.statusText;
    throw new Error(`OpenRouter request failed (${backendResponse.status}): ${detail}`);
  }

  return backendResponse;
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return Response.json(
      { detail: 'OPENROUTER_API_KEY is not configured in the Next.js environment.' },
      { status: 500 },
    );
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ detail: 'Request body must be valid JSON.' }, { status: 400 });
  }
  if (!isRecord(input)) {
    return Response.json({ detail: 'Request body must be a JSON object.' }, { status: 400 });
  }

  let conversation: ChatHistoryMessage[];
  if (input.messages !== undefined && input.messages !== null) {
    if (!Array.isArray(input.messages) || !input.messages.every(isChatHistoryMessage)) {
      return Response.json({ detail: 'messages must be an array of user/assistant messages.' }, { status: 400 });
    }
    conversation = input.messages.map(({ role, content }) => ({ role, content }));
  } else {
    if (input.history !== undefined &&
        (!Array.isArray(input.history) || !input.history.every(isChatHistoryMessage))) {
      return Response.json({ detail: 'history must be an array of user/assistant messages.' }, { status: 400 });
    }
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
      return Response.json({ detail: 'Provide a non-empty prompt or chat messages.' }, { status: 422 });
    }
    const history = Array.isArray(input.history) ? input.history : [];
    conversation = [
      ...history.slice(-6).map(({ role, content }) => ({ role, content })),
      { role: 'user', content: input.prompt.trim() },
    ];
  }

  const latestUserMessage = [...conversation].reverse().find(message => message.role === 'user');
  if (!latestUserMessage) {
    return Response.json({ detail: 'Chat history must include a user message.' }, { status: 422 });
  }
  const query = latestUserMessage.content;
  if (!query.trim()) {
    return Response.json({ detail: 'The latest user message cannot be empty.' }, { status: 422 });
  }

  const imageBase64 = input.image_base64;
  const imageUrl = input.imageUrl;
  if ((imageBase64 !== undefined && imageBase64 !== null && typeof imageBase64 !== 'string') ||
      (imageUrl !== undefined && imageUrl !== null && typeof imageUrl !== 'string')) {
    return Response.json({ detail: 'image_base64 and imageUrl must be strings.' }, { status: 400 });
  }
  const imageData = typeof imageBase64 === 'string' && imageBase64
    ? imageBase64
    : typeof imageUrl === 'string' ? imageUrl : '';
  const promptMessages: OpenRouterMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...conversation,
  ];

  if (imageData) {
    const imageDataUrl = imageData.startsWith('data:')
      ? imageData
      : `data:image/png;base64,${imageData}`;
    const userMessage = promptMessages.findLast(message => message.role === 'user');
    if (userMessage && typeof userMessage.content === 'string') {
      const messageIndex = promptMessages.lastIndexOf(userMessage);
      promptMessages[messageIndex] = {
        role: 'user',
        content: [
          { type: 'text', text: query },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      };
    }
  }

  let backendResponse: Response;
  try {
    backendResponse = await requestCompletion(
      apiKey,
      'meta-llama/llama-3.3-70b-instruct:free',
      promptMessages,
      request.signal,
    );
  } catch (primaryError: unknown) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.warn('Primary model failed; retrying generation with openrouter/free:', getErrorMessage(primaryError));
    try {
      backendResponse = await requestCompletion(apiKey, 'openrouter/free', promptMessages, request.signal);
    } catch (fallbackError: unknown) {
      console.error('OpenRouter CAD chat generation failed:', getErrorMessage(fallbackError));
      return Response.json(
        { detail: `CAD generation failed: ${getErrorMessage(fallbackError)}` },
        { status: 502 },
      );
    }
  }

  return new Response(backendResponse.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
