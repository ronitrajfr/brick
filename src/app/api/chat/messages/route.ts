import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/server/db";
import { auth } from "@/server/auth";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { headers } from "next/headers";
import { env } from "@/env";

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

const bodySchema = z.object({
  chatId: z.string(),
  content: z.string(),
  role: z.enum(["USER", "ASSISTANT", "SYSTEM"]),
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
    const { chatId, content, role } = bodySchema.parse(body);

    const message = await db.message.create({
      data: {
        content,
        role,
        chatId,
        userId: session.user.id,
      },
    });

    const cacheKey = `user:messages:${session.user.id}:chat:${chatId}`;
    await redis.del(cacheKey);

    return NextResponse.json({ message });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: `[[MESSAGES_POST]] -- ${error}` },
      { status: 500 },
    );
  }
}

const getReqRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, "10 s"),
  analytics: true,
});

const getBodySchema = z.object({
  chatId: z.string(),
});

export async function GET(req: NextRequest) {
  try {
    const headersList = await headers();
    const ip = headersList.get("x-forwarded-for") ?? "anonymous";

    const { success, limit, reset, remaining } =
      await getReqRateLimit.limit(ip);
    if (!success) {
      return NextResponse.json(
        { error: "Too many requests", limit, reset, remaining },
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

    const { searchParams } = new URL(req.url);
    const chatId = searchParams.get("chatId");
    if (!chatId) {
      return NextResponse.json({ error: "Missing chatId" }, { status: 400 });
    }

    const cacheKey = `user:messages:${session.user.id}:chat:${chatId}`;
    const cachedMessages = await redis.get<string>(cacheKey);

    if (cachedMessages) {
      const messages =
        typeof cachedMessages === "string"
          ? JSON.parse(cachedMessages)
          : cachedMessages;

      return NextResponse.json({ messages, cached: true }, { status: 200 });
    }

    const messages = await db.message.findMany({
      where: { chatId },
      orderBy: { createdAt: "asc" },
    });

    await redis.set(cacheKey, JSON.stringify(messages), { ex: 300 });

    return NextResponse.json({ messages, cached: false }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: `[[MESSAGES_GET]] -- ${error}` },
      { status: 500 },
    );
  }
}
