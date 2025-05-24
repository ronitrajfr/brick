import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/server/db";
import { auth } from "@/server/auth";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { headers } from "next/headers";
import { env } from "@/env";
import { SYSTEM_PROMPT } from "@/utils/prompt";
import { google } from "@ai-sdk/google";
import { streamText, type Message } from "ai";

const bodySchema = z.object({
  chatId: z.string(),
  content: z.string(),
});

const redis = new Redis({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
});

//10 REQUESTS PER 10 SECONDS
const postReqRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "10 s"),
  analytics: true,
});

export async function POST(req: NextRequest) {
  try {
    const headersList = await headers();
    const ip = headersList.get("x-forwarded-for") ?? "anonymous";

    const { success, limit, reset, remaining } =
      await postReqRateLimit.limit(ip);
    if (!success) {
      return NextResponse.json(
        {
          error: "Too many requests",
          limit,
          reset,
          remaining,
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": limit.toString(),
            "X-RateLimit-Remaining": remaining.toString(),
            "X-RateLimit-Reset": reset.toString(),
          },
        },
      );
    }

    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { chatId, content } = bodySchema.parse(body);

    const messages: Message[] = [
      { id: crypto.randomUUID(), role: "user", content: content },
    ];

    const result = await streamText({
      model: google("gemini-2.0-flash-lite"),
      system: SYSTEM_PROMPT,
      messages,
      onFinish: async ({ text }) => {
        if (text) {
          try {
            await db.message.create({
              data: {
                content: text,
                role: "ASSISTANT",
                chatId: chatId,
                userId: session.user.id,
              },
            });
            console.log("AI response saved to DB for chat:", chatId);
          } catch (dbError) {
            console.error("Error saving AI response to database:", dbError);
          }
        }
      },
    });

    return result.toDataStreamResponse({});
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: `[[AI_RESPONSE_POST]] -- ${error}` },
      { status: 500 },
    );
  }
}
