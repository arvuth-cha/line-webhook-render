import crypto from "node:crypto";
import express from "express";

const app = express();
const port = process.env.PORT || 3000;

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

async function replyWithEcho(replyToken, text) {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");
  }

  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [
        {
          type: "text",
          text: `Echo: ${text}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LINE Reply API ${response.status}: ${errorText}`);
  }
}

app.get("/", (req, res) => {
  res.type("text").send("LINE Webhook server is running");
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

    // Acknowledge the Webhook quickly; process replies after returning 200.
    res.sendStatus(200);

    for (const event of payload.events ?? []) {
      if (
        event.type === "message" &&
        event.message?.type === "text" &&
        event.replyToken
      ) {
        try {
          await replyWithEcho(event.replyToken, event.message.text);
          console.log(
            JSON.stringify({
              webhookEventId: event.webhookEventId,
              userId: event.source?.userId,
              action: "echo_reply_sent",
            })
          );
        } catch (error) {
          console.error(
            JSON.stringify({
              webhookEventId: event.webhookEventId,
              action: "echo_reply_failed",
              error: error instanceof Error ? error.message : String(error),
            })
          );
        }
      }
    }
  }
);

app.listen(port, () => {
  console.log(`LINE Webhook server listening on port ${port}`);
});
