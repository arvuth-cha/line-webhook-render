import crypto from "node:crypto";
import express from "express";

const app = express();
const port = process.env.PORT || 3000;
const openAiBaseUrl = (
  process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
).replace(/\/$/, "");
const openAiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";

function verifyLineSignature(rawBody, signature) {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  if (!channelSecret || !signature || !Buffer.isBuffer(rawBody)) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");

  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

async function generateAiReply(userText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const response = await fetch(`${openAiBaseUrl}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: openAiModel,
      temperature: 0.7,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content:
            "คุณคือผู้ช่วยที่ตอบผ่าน LINE ให้ตอบเป็นภาษาเดียวกับผู้ใช้ กระชับ สุภาพ และไม่กล่าวอ้างว่าทำสิ่งที่ยังไม่ได้ทำ",
        },
        {
          role: "user",
          content: userText,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("OpenAI API returned no text");
  }

  return text.slice(0, 4900);
}

async function replyToLine(replyToken, text) {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");
  }

  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LINE Reply API ${response.status}: ${errorText}`);
  }
}

app.get("/", (req, res) => {
  res.type("text").send("LINE AI Webhook server is running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post(
  "/webhook/line",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.get("x-line-signature");
    const rawBody = req.body;

    if (!verifyLineSignature(rawBody, signature)) {
      return res.status(401).send("invalid signature");
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).send("invalid json");
    }

    // Acknowledge LINE quickly, then perform the AI call and reply.
    res.sendStatus(200);

    for (const event of payload.events ?? []) {
      if (
        event.type === "message" &&
        event.message?.type === "text" &&
        event.replyToken
      ) {
        try {
          const aiText = await generateAiReply(event.message.text);
          await replyToLine(event.replyToken, aiText);
          console.log(
            JSON.stringify({
              webhookEventId: event.webhookEventId,
              userId: event.source?.userId,
              action: "ai_reply_sent",
              model: openAiModel,
            })
          );
        } catch (error) {
          console.error(
            JSON.stringify({
              webhookEventId: event.webhookEventId,
              action: "ai_reply_failed",
              error: error instanceof Error ? error.message : String(error),
            })
          );
        }
      }
    }
  }
);

app.listen(port, () => {
  console.log(`LINE AI Webhook server listening on port ${port}`);
});
